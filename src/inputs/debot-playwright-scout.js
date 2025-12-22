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
            console.log('[DeBot Scout] 正在加载 DeBot 聪明钱页面...');
            await this.page.goto('https://debot.ai/smart-money', {
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
            
            // 只处理 DeBot API 请求
            if (!url.includes('debot.ai') && !url.includes('debot')) return;
            
            // 调试：打印 API 请求
            if (url.includes('/api/') || url.includes('smart') || url.includes('wallet')) {
                console.log(`[DeBot Scout] 📡 捕获请求: ${url.split('?')[0].split('/').slice(-2).join('/')}`);
            }
            
            try {
                const contentType = response.headers()['content-type'] || '';
                if (!contentType.includes('application/json')) return;
                
                const data = await response.json();
                
                // 处理聪明钱数据
                if (url.includes('smart') || url.includes('wallet') || url.includes('trade')) {
                    this.handleSmartMoneyData(url, data);
                }
                
            } catch (error) {
                // 忽略解析错误
            }
        });
    }
    
    /**
     * 处理聪明钱数据
     */
    handleSmartMoneyData(url, data) {
        // 尝试从不同格式中提取数据
        let items = [];
        
        if (data?.data?.list && Array.isArray(data.data.list)) {
            items = data.data.list;
        } else if (data?.data && Array.isArray(data.data)) {
            items = data.data;
        } else if (data?.list && Array.isArray(data.list)) {
            items = data.list;
        } else if (Array.isArray(data)) {
            items = data;
        }
        
        if (items.length === 0) return;
        
        console.log(`[DeBot Scout] 📊 获取到 ${items.length} 条聪明钱数据`);
        
        // 处理每条数据
        for (const item of items.slice(0, 20)) {
            const signal = this.createSignal(item);
            if (signal && this.isNewSignal(signal)) {
                const action = signal.action === 'buy' ? '买入' : '卖出';
                const emoji = signal.action === 'buy' ? '🟢' : '🔴';
                console.log(`[DeBot Scout] ${emoji} 聪明钱${action}: ${signal.symbol} (${signal.chain})`);
                this.emit('signal', signal);
            }
        }
    }
    
    /**
     * 创建信号对象
     */
    createSignal(item) {
        const tokenCA = item.token_address || item.address || item.ca || item.contract;
        if (!tokenCA) return null;
        
        // 判断是买入还是卖出
        const action = (item.type === 'buy' || item.action === 'buy' || item.side === 'buy') ? 'buy' : 'sell';
        
        // 判断链
        let chain = 'SOL';
        if (item.chain) {
            chain = item.chain.toUpperCase();
        } else if (tokenCA.startsWith('0x')) {
            chain = 'BSC';
        }
        
        return {
            token_ca: tokenCA,
            chain: chain,
            symbol: item.symbol || item.token_symbol || 'Unknown',
            name: item.name || item.token_name || item.symbol || 'Unknown',
            signal_type: 'smart_money',
            action: action,
            emoji: action === 'buy' ? '🟢' : '🔴',
            wallet: item.wallet || item.address || item.from,
            amount: item.amount || item.value || 0,
            price: item.price || 0,
            source: 'debot_playwright',
            timestamp: Date.now()
        };
    }
    
    /**
     * 检查是否是新信号
     */
    isNewSignal(signal) {
        const cacheKey = `${signal.chain}:${signal.token_ca}:${signal.action}`;
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
                // 轮换不同链
                const pages = [
                    'https://debot.ai/smart-money?chain=sol',
                    'https://debot.ai/smart-money?chain=bsc',
                ];
                const randomPage = pages[Math.floor(Math.random() * pages.length)];
                const chain = randomPage.includes('bsc') ? 'BSC' : 'SOL';
                
                console.log(`[DeBot Scout] 🔄 切换到 ${chain} 聪明钱`);
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
