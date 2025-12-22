/**
 * DeBot Playwright Scout - 聪明钱追踪
 * 
 * 通过 Playwright 访问 DeBot 页面，拦截 API 数据
 * 获取聪明钱买入/卖出信号
 */

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载 Stealth 插件
chromium.use(stealth());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class DebotPlaywrightScout extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            sessionPath: config.sessionPath || path.join(__dirname, '../../config/debot_session.json'),
            chains: config.chains || ['sol', 'bsc'],
            headless: config.headless !== false,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isRunning = false;
        this.refreshTimer = null;
        this.lastSeenTokens = new Map();
        
        console.log('[DeBot Scout] Playwright 模式初始化');
    }
    
    /**
     * 检查 Session 是否存在
     */
    hasSession() {
        return fs.existsSync(this.config.sessionPath);
    }
    
    /**
     * 启动 Scout
     */
    async start() {
        if (this.isRunning) {
            console.log('[DeBot Scout] 已经在运行中');
            return;
        }
        
        // 检查 Session
        if (!this.hasSession()) {
            console.error('[DeBot Scout] ❌ 未找到登录 Session!');
            console.error('[DeBot Scout] 请先运行: node scripts/debot-login-setup.js');
            return;
        }
        
        console.log('[DeBot Scout] 🚀 启动中...');
        
        try {
            // 启动浏览器
            this.browser = await chromium.launch({
                headless: this.config.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            
            // 加载 Session
            this.context = await this.browser.newContext({
                storageState: this.config.sessionPath,
                userAgent: this.config.userAgent,
                viewport: { width: 1920, height: 1080 }
            });
            
            this.page = await this.context.newPage();
            
            // 设置网络拦截
            this.setupNetworkInterceptor();
            
            // 访问 DeBot 聪明钱页面
            console.log('[DeBot Scout] 正在加载 DeBot SOL 页面...');
            await this.page.goto('https://debot.ai/?chain=solana', {
                waitUntil: 'load',
                timeout: 60000
            });
            
            // 等待页面加载
            await this.page.waitForTimeout(5000);
            
            console.log('[DeBot Scout] ✅ 页面加载完成');
            
            // 设置定时刷新
            this.isRunning = true;
            this.scheduleRefresh();
            
            console.log('[DeBot Scout] ✅ 聪明钱监控已启动');
            
        } catch (error) {
            console.error('[DeBot Scout] ❌ 启动失败:', error.message);
            await this.stop();
        }
    }
    
    /**
     * 设置网络请求拦截器
     */
    setupNetworkInterceptor() {
        this.page.on('response', async (response) => {
            const url = response.url();
            
            // 跳过非 API 请求
            if (url.includes('.js') || url.includes('.css') || url.includes('.png') || 
                url.includes('.svg') || url.includes('.woff') || url.includes('google') ||
                url.includes('cdn-cgi') || url.includes('cloudflare')) {
                return;
            }
            
            try {
                const contentType = response.headers()['content-type'] || '';
                if (!contentType.includes('json')) return;
                
                const data = await response.json();
                const shortUrl = url.split('?')[0].split('/').slice(-2).join('/');
                
                // 跳过无用的 API
                if (url.includes('debot/wallets') || url.includes('debot/connect') ||
                    url.includes('notification') || url.includes('unread') ||
                    url.includes('user/info') || url.includes('config/list')) {
                    return;
                }
                
                // 信号/榜单 API - 这是核心数据！
                if (url.includes('signal') || url.includes('rank') || url.includes('list')) {
                    console.log(`[DeBot Scout] 📡 信号API: ${shortUrl}`);
                    this.handleSignalData(url, data);
                    return;
                }
                
                // 打印其他 API 用于调试
                if (data?.data) {
                    const sample = JSON.stringify(data.data).slice(0, 200);
                    console.log(`[DeBot Scout] 📡 ${shortUrl}: ${sample}...`);
                }
                
            } catch (error) {
                // 忽略解析错误
            }
        });
    }
    
    /**
     * 处理信号数据 (AI信号卡片)
     * 
     * DeBot heatmap API 返回格式:
     * {
     *   data: {
     *     meta: {
     *       signals: {
     *         "代币地址": {
     *           signal_count: 8,
     *           first_time: 1766365322,
     *           first_price: 0.0000354959,
     *           max_price: 0.0004324634,
     *           max_price_gain: 11.18,  // 最大涨幅倍数
     *           token_level: "silver"   // bronze/silver/gold
     *         }
     *       }
     *     },
     *     heatmap: [...]
     *   }
     * }
     */
    handleSignalData(url, data) {
        // 检查是否是 heatmap API (包含 meta.signals)
        if (data?.data?.meta?.signals) {
            this.handleHeatmapSignals(data.data.meta.signals);
            return;
        }
        
        // 其他格式的信号数据
        let items = [];
        
        if (data?.data?.list) items = data.data.list;
        else if (data?.data?.items) items = data.data.items;
        else if (data?.data && Array.isArray(data.data)) items = data.data;
        else if (data?.list) items = data.list;
        else if (Array.isArray(data)) items = data;
        
        if (items.length === 0) {
            // 不再打印警告，减少日志噪音
            return;
        }
        
        console.log(`[DeBot Scout] 📊 获取到 ${items.length} 条信号`);
        
        for (const item of items) {
            this.processSignalItem(item);
        }
    }
    
    /**
     * 处理 heatmap API 的 signals 数据
     */
    handleHeatmapSignals(signals) {
        const tokenAddresses = Object.keys(signals);
        if (tokenAddresses.length === 0) return;
        
        console.log(`[DeBot Scout] 📊 获取到 ${tokenAddresses.length} 个 AI 信号代币`);
        
        // 按 signal_count 或 max_price_gain 排序
        const sortedTokens = tokenAddresses
            .map(addr => ({ address: addr, ...signals[addr] }))
            .sort((a, b) => (b.signal_count || 0) - (a.signal_count || 0))
            .slice(0, 20);
        
        for (const token of sortedTokens) {
            this.processHeatmapSignal(token);
        }
    }
    
    /**
     * 处理单个 heatmap 信号
     */
    processHeatmapSignal(token) {
        const tokenAddress = token.address;
        if (!tokenAddress) return;
        
        // 检查是否重复 (30分钟内)
        const cacheKey = `heatmap:${tokenAddress}`;
        const now = Date.now();
        if (this.lastSeenTokens.has(cacheKey)) {
            const lastSeen = this.lastSeenTokens.get(cacheKey);
            if (now - lastSeen < 30 * 60 * 1000) return;
        }
        this.lastSeenTokens.set(cacheKey, now);
        
        // 检测链 - SOL 地址通常不以 0x 开头
        const chain = tokenAddress.startsWith('0x') ? 'bsc' : 'sol';
        
        // 构建信号 - 使用 injectSignal 兼容的字段名
        const signal = {
            source: 'DeBot_AI',
            type: 'AI_SIGNAL',
            emoji: token.token_level === 'gold' ? '🥇' : 
                   token.token_level === 'silver' ? '🥈' : '🥉',
            action: 'buy',
            chain: chain,
            token_ca: tokenAddress,  // injectSignal 期望的字段名
            tokenAddress: tokenAddress,
            symbol: tokenAddress.slice(0, 8) + '...',
            tokenName: tokenAddress.slice(0, 8) + '...',
            
            // DeBot heatmap 特有数据
            signalCount: token.signal_count || 0,
            smart_money_count: token.signal_count || 0,  // 复用信号次数作为聪明钱数量
            firstTime: token.first_time || 0,
            firstPrice: token.first_price || 0,
            maxPrice: token.max_price || 0,
            maxPriceGain: token.max_price_gain || 0,  // 🔥 最大涨幅倍数
            tokenLevel: token.token_level || 'bronze', // bronze/silver/gold
            
            timestamp: now,
            raw: token
        };
        
        // 根据 token_level 和涨幅判断质量
        const levelEmoji = signal.tokenLevel === 'gold' ? '🥇' : 
                          signal.tokenLevel === 'silver' ? '🥈' : '🥉';
        
        // 只打印有意义的信号 (signal_count >= 3 或 max_price_gain >= 3)
        if (signal.signalCount >= 3 || signal.maxPriceGain >= 3) {
            console.log(`[DeBot Scout] ${levelEmoji} AI信号: ${tokenAddress.slice(0, 12)}...`);
            console.log(`   📊 ${signal.signalCount}次信号, 最高涨幅 ${signal.maxPriceGain.toFixed(1)}x`);
        }
        
        // 只发送有价值的信号
        if (signal.signalCount >= 5 || signal.maxPriceGain >= 5 || signal.tokenLevel === 'gold') {
            this.emit('signal', signal);
        }
    }
    
    /**
     * 处理单个信号项
     */
    processSignalItem(item) {
        // 尝试提取代币地址（不同字段名）
        const tokenAddress = item.token_address || item.tokenAddress || item.address || 
                            item.mint || item.contract || item.token || item.ca;
        
        if (!tokenAddress) {
            // 打印数据结构以便调试
            const keys = Object.keys(item).slice(0, 10);
            console.log(`[DeBot Scout] ⚠️ 信号无代币地址, 字段: ${keys.join(', ')}`);
            return;
        }
        
        // 检查是否重复
        const cacheKey = `${tokenAddress}_${Date.now() - (Date.now() % 60000)}`; // 1分钟内去重
        if (this.lastSeenTokens.has(tokenAddress)) {
            const lastSeen = this.lastSeenTokens.get(tokenAddress);
            if (Date.now() - lastSeen < 60000) return; // 1分钟内重复
        }
        this.lastSeenTokens.set(tokenAddress, Date.now());
        
        // 检测链
        const chain = (item.chain || 'sol').toLowerCase();
        const normalizedChain = chain.includes('bsc') || chain.includes('bnb') ? 'bsc' : 
                                chain.includes('sol') || chain.includes('solana') ? 'sol' : chain;
        
        // 提取信号详情 - 使用 injectSignal 期望的字段名
        const signal = {
            source: 'DeBot',
            type: 'AI_SIGNAL',
            emoji: '🤖',
            action: 'buy',
            chain: normalizedChain,
            token_ca: tokenAddress,  // injectSignal 期望的字段名
            tokenAddress: tokenAddress,
            symbol: item.name || item.symbol || item.token_name || 'Unknown',
            tokenName: item.name || item.symbol || item.token_name || 'Unknown',
            
            // DeBot 特有的丰富数据
            smart_money_count: item.smart_money_count || item.smartMoneyCount || item.whale_count || 0,
            smartMoneyCount: item.smart_money_count || item.smartMoneyCount || item.whale_count || 0,
            avgBuyAmount: item.avg_buy_amount || item.avgBuyAmount || 0,
            marketCap: item.market_cap || item.marketCap || item.mc || 0,
            holders: item.holders || item.holder_count || 0,
            price: item.price || 0,
            priceChange: item.price_change || item.priceChange || 0,
            liquidity: item.liquidity || item.pool || item.lp || 0,
            top10Percent: item.top10_percent || item.top10 || 0,
            multiplier: item.multiplier || item.x || 0,
            
            timestamp: Date.now(),
            raw: item
        };
        
        // 只有有效的信号才打印和发送 (有聪明钱数据或有意义的数据)
        if (signal.smartMoneyCount > 0 || signal.marketCap > 0) {
            console.log(`[DeBot Scout] 🔔 AI信号: ${signal.symbol} (${tokenAddress.slice(0, 8)}...)`);
            console.log(`   💰 ${signal.smartMoneyCount}个聪明钱包买入, 平均$${signal.avgBuyAmount}`);
            console.log(`   📊 市值: $${signal.marketCap}, 池子: $${signal.liquidity}`);
            
            // 发送信号
            this.emit('signal', signal);
        }
    }
    
    /**
     * 检查是否是新信号
     */
    isNewSignal(signal) {
        const cacheKey = `${signal.chain}:${signal.tokenAddress}`;
        const now = Date.now();
        
        if (this.lastSeenTokens.has(cacheKey)) {
            const lastSeen = this.lastSeenTokens.get(cacheKey);
            if (now - lastSeen < 10 * 60 * 1000) { // 10分钟内不重复
                return false;
            }
        }
        
        this.lastSeenTokens.set(cacheKey, now);
        return true;
    }
    
    /**
     * 定时刷新页面
     */
    scheduleRefresh() {
        if (!this.isRunning) return;
        
        // 30-60秒间隔
        const interval = 30000 + Math.random() * 30000;
        
        this.refreshTimer = setTimeout(async () => {
            if (!this.isRunning) return;
            
            try {
                // 轮换 SOL 和 BSC
                const pages = [
                    'https://debot.ai/?chain=solana',
                    'https://debot.ai/?chain=bsc',
                ];
                const randomPage = pages[Math.floor(Math.random() * pages.length)];
                const chain = randomPage.includes('bsc') ? 'BSC' : 'SOL';
                
                console.log(`[DeBot Scout] 🔄 切换到 ${chain}`);
                await this.page.goto(randomPage, { 
                    waitUntil: 'load',
                    timeout: 60000
                });
                
                await this.page.waitForTimeout(3000);
                
            } catch (error) {
                console.error('[DeBot Scout] 刷新错误:', error.message.split('\n')[0]);
            }
            
            this.scheduleRefresh();
            
        }, interval);
    }
    
    /**
     * 停止 Scout
     */
    async stop() {
        this.isRunning = false;
        
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        
        console.log('[DeBot Scout] ⏹️ 已停止');
    }
    
    /**
     * 获取状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            hasSession: this.hasSession(),
            cachedTokens: this.lastSeenTokens.size
        };
    }
}

export default DebotPlaywrightScout;
