/**
 * GMGN Playwright Scout - 全自动数据抓取
 * 
 * 核心原理:
 * 1. 使用保存的登录态访问 GMGN
 * 2. 拦截浏览器发出的 API 请求
 * 3. 直接获取 JSON 数据，绕过 Cloudflare
 * 
 * 支持的信号:
 * - 🐋 Smart Money (聪明钱)
 * - 👑 KOL (KOL持仓)
 * - 🚀 Trending (飙升榜)
 * - 🔥 Hot (热门榜)
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

export class GMGNPlaywrightScout extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            sessionPath: config.sessionPath || path.join(__dirname, '../config/gmgn_session.json'),
            chains: config.chains || ['sol'],
            refreshInterval: config.refreshInterval || 15000 + Math.random() * 5000, // 15-20秒随机
            headless: config.headless !== false,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isRunning = false;
        this.refreshTimer = null;
        this.lastSeenTokens = new Map();
        
        // API 端点匹配规则
        this.apiPatterns = {
            smartMoney: /\/rank\/\w+\/swaps.*orderby=smartmoney/i,
            kol: /\/rank\/\w+\/swaps.*orderby=kol/i,
            trending: /\/rank\/\w+\/swaps/i,
            signals: /\/signal/i,
            tokenInfo: /\/tokens\/\w+\/[A-Za-z0-9]+/i
        };
        
        console.log('[GMGN Scout] Playwright 模式初始化');
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
            console.log('[GMGN Scout] 已经在运行中');
            return;
        }
        
        // 检查 Session
        if (!this.hasSession()) {
            console.error('[GMGN Scout] ❌ 未找到登录 Session!');
            console.error('[GMGN Scout] 请先运行: node scripts/gmgn-login-setup.js');
            return;
        }
        
        console.log('[GMGN Scout] 🚀 启动中...');
        
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
            
            // 访问 GMGN
            console.log('[GMGN Scout] 正在加载 GMGN...');
            await this.page.goto('https://gmgn.ai/discover?chain=sol', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            console.log('[GMGN Scout] ✅ 页面加载完成');
            
            // 设置定时刷新
            this.isRunning = true;
            this.scheduleRefresh();
            
            console.log('[GMGN Scout] ✅ 信号监控已启动');
            console.log(`[GMGN Scout] 刷新间隔: ${Math.round(this.config.refreshInterval / 1000)}秒`);
            
        } catch (error) {
            console.error('[GMGN Scout] ❌ 启动失败:', error.message);
            await this.stop();
        }
    }
    
    /**
     * 设置网络请求拦截器
     */
    setupNetworkInterceptor() {
        this.page.on('response', async (response) => {
            const url = response.url();
            
            // 只处理 GMGN API 请求
            if (!url.includes('gmgn.ai/defi/quotation')) return;
            
            try {
                const contentType = response.headers()['content-type'] || '';
                if (!contentType.includes('application/json')) return;
                
                const data = await response.json();
                
                // 检测数据类型并处理
                if (this.apiPatterns.smartMoney.test(url)) {
                    this.handleSmartMoneyData(data);
                } else if (this.apiPatterns.kol.test(url)) {
                    this.handleKOLData(data);
                } else if (this.apiPatterns.trending.test(url)) {
                    this.handleTrendingData(data);
                } else if (this.apiPatterns.signals.test(url)) {
                    this.handleSignalData(data);
                }
                
            } catch (error) {
                // 忽略解析错误
            }
        });
    }
    
    /**
     * 处理聪明钱数据
     */
    handleSmartMoneyData(data) {
        if (!data?.data?.rank) return;
        
        const tokens = data.data.rank.slice(0, 10);
        
        for (const token of tokens) {
            const signal = this.createSignal(token, 'smart_money', '🐋');
            if (signal && this.isNewSignal(signal)) {
                console.log(`[GMGN Scout] 🐋 Smart Money: ${signal.symbol} - ${signal.smart_money_count} 个聪明钱`);
                this.emit('signal', signal);
            }
        }
    }
    
    /**
     * 处理 KOL 数据
     */
    handleKOLData(data) {
        if (!data?.data?.rank) return;
        
        const tokens = data.data.rank.slice(0, 10);
        
        for (const token of tokens) {
            if ((token.kol_count || 0) >= 1) {
                const signal = this.createSignal(token, 'kol', '👑');
                if (signal && this.isNewSignal(signal)) {
                    console.log(`[GMGN Scout] 👑 KOL: ${signal.symbol} - ${signal.kol_count} 个KOL`);
                    this.emit('signal', signal);
                }
            }
        }
    }
    
    /**
     * 处理趋势数据
     */
    handleTrendingData(data) {
        if (!data?.data?.rank) return;
        
        const tokens = data.data.rank.slice(0, 15);
        
        for (const token of tokens) {
            // 飙升: 5分钟涨幅 > 20%
            const priceChange5m = parseFloat(token.price_change_5m || token.change_5m || 0);
            if (priceChange5m >= 20) {
                const signal = this.createSignal(token, 'surge', '🚀');
                signal.price_change_5m = priceChange5m;
                if (this.isNewSignal(signal)) {
                    console.log(`[GMGN Scout] 🚀 Surge: ${signal.symbol} - 5m +${priceChange5m.toFixed(1)}%`);
                    this.emit('signal', signal);
                }
            }
        }
    }
    
    /**
     * 处理信号数据
     */
    handleSignalData(data) {
        // 如果有专门的信号端点数据
        if (!data?.data) return;
        
        const signals = Array.isArray(data.data) ? data.data : [data.data];
        
        for (const item of signals.slice(0, 10)) {
            const signal = this.createSignal(item, 'signal', '📡');
            if (signal && this.isNewSignal(signal)) {
                console.log(`[GMGN Scout] 📡 Signal: ${signal.symbol}`);
                this.emit('signal', signal);
            }
        }
    }
    
    /**
     * 创建信号对象
     */
    createSignal(token, signalType, emoji) {
        const tokenCA = token.address || token.token_address || token.ca;
        if (!tokenCA) return null;
        
        return {
            token_ca: tokenCA,
            chain: 'SOL',  // GMGN 主要是 SOL
            symbol: token.symbol || 'Unknown',
            name: token.name || token.symbol || 'Unknown',
            signal_type: signalType,
            emoji: emoji,
            smart_money_count: token.smart_money_count || token.smartmoney || 0,
            kol_count: token.kol_count || 0,
            volume_24h: token.volume_24h || token.volume || 0,
            price: token.price || 0,
            price_change_5m: token.price_change_5m || token.change_5m || 0,
            price_change_1h: token.price_change_1h || token.change_1h || 0,
            liquidity: token.liquidity || 0,
            market_cap: token.market_cap || 0,
            holder_count: token.holder_count || 0,
            source: `gmgn_playwright_${signalType}`,
            timestamp: Date.now()
        };
    }
    
    /**
     * 检查是否是新信号
     */
    isNewSignal(signal) {
        const cacheKey = `${signal.chain}:${signal.token_ca}:${signal.signal_type}`;
        const now = Date.now();
        
        if (this.lastSeenTokens.has(cacheKey)) {
            const lastSeen = this.lastSeenTokens.get(cacheKey);
            if (now - lastSeen < 30 * 60 * 1000) { // 30分钟内不重复
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
        
        // 随机间隔，拟人化
        const interval = 15000 + Math.random() * 10000; // 15-25秒
        
        this.refreshTimer = setTimeout(async () => {
            if (!this.isRunning) return;
            
            try {
                // 随机选择一个页面刷新
                const pages = [
                    'https://gmgn.ai/discover?chain=sol',
                    'https://gmgn.ai/trendy?chain=sol',
                    'https://gmgn.ai/signal?chain=sol'
                ];
                const randomPage = pages[Math.floor(Math.random() * pages.length)];
                
                console.log(`[GMGN Scout] 🔄 刷新: ${randomPage.split('/').pop()}`);
                await this.page.goto(randomPage, { 
                    waitUntil: 'networkidle',
                    timeout: 30000 
                });
                
            } catch (error) {
                console.error('[GMGN Scout] 刷新错误:', error.message);
            }
            
            // 继续下一次刷新
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
        
        console.log('[GMGN Scout] ⏹️ 已停止');
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

export default GMGNPlaywrightScout;
