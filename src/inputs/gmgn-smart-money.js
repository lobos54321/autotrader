/**
 * GMGN Smart Money Scout - 替代 DeBot
 * 
 * 通过 GMGN 免费 API 获取聪明钱信号，无需 Cookie！
 * 
 * API 文档: https://github.com/imcrazysteven/GMGN-API
 * 
 * 核心 API:
 * - /rank/{chain}/swaps/{time} - 聪明钱热门代币
 * - /tokens/top_buyers/{ca} - 代币的聪明钱买家
 * - /wallet_activity/{address} - 钱包交易活动
 */

import axios from 'axios';
import { EventEmitter } from 'events';

export class GMGNSmartMoneyScout extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            baseUrl: 'https://gmgn.ai/defi/quotation/v1',
            
            // 轮询间隔（毫秒）
            pollInterval: config.pollInterval || 30000, // 30秒
            
            // 支持的链
            chains: config.chains || ['sol', 'bsc'],
            
            // 聪明钱触发阈值
            smartMoneyThreshold: {
                minSmartBuyers: config.minSmartBuyers || 2,   // 最少聪明钱买家
                minVolume24h: config.minVolume24h || 10000,   // 最低24h成交量 $
                maxAge: config.maxAge || 24 * 60 * 60 * 1000  // 代币最大年龄 24h
            },
            
            // 安全过滤
            safetyFilters: ['not_honeypot'],
            
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        };
        
        this.isRunning = false;
        this.lastSeenTokens = new Map(); // 防止重复触发
        this.pollTimers = {};
        
        console.log('[GMGN Scout] 初始化完成 - 无需 Cookie！');
    }
    
    /**
     * 获取请求头
     */
    getHeaders() {
        return {
            'accept': 'application/json',
            'user-agent': this.config.userAgent,
            'referer': 'https://gmgn.ai/'
        };
    }
    
    /**
     * 获取聪明钱热门代币
     * @param {string} chain - sol, bsc, eth
     * @param {string} period - 1m, 5m, 1h, 6h, 24h
     */
    async getSmartMoneyTokens(chain = 'sol', period = '1h') {
        try {
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/${period}`;
            
            const params = {
                orderby: 'smartmoney',
                direction: 'desc',
                'filters[]': this.config.safetyFilters
            };
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params,
                timeout: 15000
            });
            
            if (response.data && response.data.data) {
                const tokens = response.data.data.rank || [];
                console.log(`[GMGN Scout] ${chain.toUpperCase()} 获取 ${tokens.length} 个聪明钱代币`);
                return tokens;
            }
            
            return [];
            
        } catch (error) {
            console.error(`[GMGN Scout] 获取聪明钱代币失败: ${error.message}`);
            return [];
        }
    }
    
    /**
     * 获取代币的聪明钱买家数量
     * @param {string} tokenCA - 代币合约地址
     * @param {string} chain - sol, bsc
     */
    async getSmartMoneyBuyers(tokenCA, chain = 'sol') {
        try {
            const url = `${this.config.baseUrl}/tokens/top_buyers/${chain}/${tokenCA}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 10000
            });
            
            if (response.data && response.data.data) {
                const buyers = response.data.data || [];
                const smartBuyers = buyers.filter(b => b.is_smart_money || b.smart_money);
                return {
                    total_buyers: buyers.length,
                    smart_buyers: smartBuyers.length,
                    smart_buyer_list: smartBuyers.slice(0, 10) // Top 10
                };
            }
            
            return { total_buyers: 0, smart_buyers: 0, smart_buyer_list: [] };
            
        } catch (error) {
            // 静默失败，返回空数据
            return { total_buyers: 0, smart_buyers: 0, smart_buyer_list: [] };
        }
    }
    
    /**
     * 获取代币详情（包含聪明钱数据）
     */
    async getTokenInfo(tokenCA, chain = 'sol') {
        try {
            const url = `${this.config.baseUrl}/tokens/${chain}/${tokenCA}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 10000
            });
            
            if (response.data && response.data.data) {
                return response.data.data;
            }
            
            return null;
            
        } catch (error) {
            return null;
        }
    }
    
    /**
     * 扫描并返回符合条件的聪明钱信号
     */
    async scan(chain = 'sol') {
        const tokens = await this.getSmartMoneyTokens(chain, '1h');
        const signals = [];
        
        for (const token of tokens.slice(0, 20)) { // 只处理前20个
            try {
                const tokenCA = token.address || token.token_address;
                if (!tokenCA) continue;
                
                // 检查是否已处理过
                const cacheKey = `${chain}:${tokenCA}`;
                if (this.lastSeenTokens.has(cacheKey)) {
                    const lastSeen = this.lastSeenTokens.get(cacheKey);
                    if (Date.now() - lastSeen < 30 * 60 * 1000) { // 30分钟内不重复
                        continue;
                    }
                }
                
                // 获取聪明钱买家数据
                const buyerData = await this.getSmartMoneyBuyers(tokenCA, chain);
                
                // 检查阈值
                if (buyerData.smart_buyers >= this.config.smartMoneyThreshold.minSmartBuyers) {
                    const signal = {
                        token_ca: tokenCA,
                        chain: chain.toUpperCase(),
                        symbol: token.symbol || 'Unknown',
                        name: token.name || token.symbol || 'Unknown',
                        smart_money_count: buyerData.smart_buyers,
                        total_buyers: buyerData.total_buyers,
                        volume_24h: token.volume_24h || token.volume || 0,
                        price: token.price || 0,
                        price_change_1h: token.price_change_1h || 0,
                        liquidity: token.liquidity || 0,
                        market_cap: token.market_cap || 0,
                        source: 'gmgn_smart_money',
                        timestamp: Date.now()
                    };
                    
                    signals.push(signal);
                    this.lastSeenTokens.set(cacheKey, Date.now());
                    
                    console.log(`[GMGN Scout] 🐋 发现聪明钱信号: ${signal.symbol} (${chain.toUpperCase()}) - ${buyerData.smart_buyers} 个聪明钱`);
                }
                
            } catch (error) {
                // 静默跳过单个代币错误
                continue;
            }
        }
        
        return signals;
    }
    
    /**
     * 启动轮询
     */
    async start() {
        if (this.isRunning) {
            console.log('[GMGN Scout] 已经在运行中');
            return;
        }
        
        this.isRunning = true;
        console.log('[GMGN Scout] 🚀 启动聪明钱监控...');
        
        // 立即执行一次
        await this.pollOnce();
        
        // 设置定时轮询
        for (const chain of this.config.chains) {
            this.pollTimers[chain] = setInterval(async () => {
                if (!this.isRunning) return;
                
                try {
                    const signals = await this.scan(chain);
                    
                    for (const signal of signals) {
                        this.emit('signal', signal);
                    }
                    
                } catch (error) {
                    console.error(`[GMGN Scout] ${chain} 轮询错误:`, error.message);
                }
                
            }, this.config.pollInterval);
        }
        
        console.log('[GMGN Scout] ✅ 聪明钱监控已启动');
    }
    
    /**
     * 执行一次扫描
     */
    async pollOnce() {
        for (const chain of this.config.chains) {
            try {
                const signals = await this.scan(chain);
                
                for (const signal of signals) {
                    this.emit('signal', signal);
                }
                
            } catch (error) {
                console.error(`[GMGN Scout] ${chain} 扫描错误:`, error.message);
            }
        }
    }
    
    /**
     * 停止轮询
     */
    stop() {
        this.isRunning = false;
        
        for (const chain of Object.keys(this.pollTimers)) {
            if (this.pollTimers[chain]) {
                clearInterval(this.pollTimers[chain]);
                delete this.pollTimers[chain];
            }
        }
        
        console.log('[GMGN Scout] ⏹️ 聪明钱监控已停止');
    }
    
    /**
     * 获取状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            chains: this.config.chains,
            pollInterval: this.config.pollInterval,
            cachedTokens: this.lastSeenTokens.size
        };
    }
}

export default GMGNSmartMoneyScout;
