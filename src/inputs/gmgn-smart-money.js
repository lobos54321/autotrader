/**
 * GMGN 多维信号源 - 全功能版
 * 
 * 通过 GMGN 免费 API 获取多种信号，无需 Cookie！
 * 
 * 支持的信号类型:
 * 1. Smart Money (聪明钱) - 追踪聪明钱买入
 * 2. KOL Signals (KOL信号) - 追踪 KOL 持仓变化
 * 3. Trending/Surge (飙升榜) - 价格/成交量飙升预警
 * 4. DEX Paid (付费推广) - Dexscreener 付费信号
 * 5. AI Signals (AI信号) - GMGN AI 推荐
 * 
 * API 文档: https://github.com/imcrazysteven/GMGN-API
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
            
            // 启用的信号类型
            enabledSignals: config.enabledSignals || {
                smartMoney: true,    // 聪明钱
                kol: true,           // KOL
                trending: true,      // 飙升榜/Surge
                dexPaid: true,       // DEX付费
                aiSignal: true,      // AI信号
                trenches: true,      // 战壕（新币聚合）
                hot: true            // 热门榜
            },
            
            // 聪明钱触发阈值
            smartMoneyThreshold: {
                minSmartBuyers: config.minSmartBuyers || 2,
                minVolume24h: config.minVolume24h || 10000,
                maxAge: config.maxAge || 24 * 60 * 60 * 1000
            },
            
            // 飙升榜阈值
            surgeThreshold: {
                priceChange5m: 20,   // 5分钟涨幅 > 20%
                priceChange1h: 50,   // 1小时涨幅 > 50%
                volumeIncrease: 3    // 成交量增加 3倍
            },
            
            // 安全过滤
            safetyFilters: ['not_honeypot'],
            
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        };
        
        this.isRunning = false;
        this.lastSeenTokens = new Map();
        this.pollTimers = {};
        
        console.log('[GMGN] 🚀 多维信号源初始化完成 - 无需 Cookie！');
        console.log(`[GMGN] 启用信号: ${Object.entries(this.config.enabledSignals).filter(([k,v]) => v).map(([k]) => k).join(', ')}`);
    }
    
    getHeaders() {
        return {
            'accept': 'application/json',
            'user-agent': this.config.userAgent,
            'referer': 'https://gmgn.ai/'
        };
    }
    
    // ==========================================
    // 1. 聪明钱信号 (Smart Money)
    // ==========================================
    async getSmartMoneyTokens(chain = 'sol', period = '1h') {
        try {
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/${period}`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'smartmoney',
                    direction: 'desc',
                    'filters[]': this.config.safetyFilters
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                return response.data.data.rank;
            }
            return [];
        } catch (error) {
            console.error(`[GMGN] 聪明钱API错误: ${error.message}`);
            return [];
        }
    }
    
    // ==========================================
    // 2. KOL 信号
    // ==========================================
    async getKOLSignals(chain = 'sol') {
        try {
            // KOL 热门持仓
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/1h`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'kol_count',  // 按 KOL 数量排序
                    direction: 'desc',
                    'filters[]': this.config.safetyFilters
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                // 过滤出有 KOL 持仓的代币
                return response.data.data.rank.filter(t => 
                    (t.kol_count || 0) >= 1 || (t.kol_holders || 0) >= 1
                );
            }
            return [];
        } catch (error) {
            console.error(`[GMGN] KOL API错误: ${error.message}`);
            return [];
        }
    }
    
    // ==========================================
    // 3. 飙升榜 (Trending/Surge Alert)
    // ==========================================
    async getSurgeTokens(chain = 'sol') {
        try {
            // 获取5分钟涨幅榜
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/5m`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'change',  // 按涨幅排序
                    direction: 'desc',
                    'filters[]': this.config.safetyFilters
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                // 过滤出飙升的代币
                return response.data.data.rank.filter(t => {
                    const change5m = parseFloat(t.price_change_5m || t.change_5m || 0);
                    return change5m >= this.config.surgeThreshold.priceChange5m;
                });
            }
            return [];
        } catch (error) {
            console.error(`[GMGN] 飙升榜API错误: ${error.message}`);
            return [];
        }
    }
    
    // ==========================================
    // 4. DEX 付费推广信号
    // ==========================================
    async getDexPaidTokens(chain = 'sol') {
        try {
            // 获取有付费推广的代币
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/1h`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'volume',
                    direction: 'desc',
                    'filters[]': ['dexscreener_ad', 'dexscreener_update']  // 付费推广过滤
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                // 过滤出有 DEX 付费标记的
                return response.data.data.rank.filter(t => 
                    t.dexscreener_ad || t.dexscreener_paid || t.is_promoted
                );
            }
            return [];
        } catch (error) {
            // DEX 付费 API 可能需要特殊权限，静默失败
            return [];
        }
    }
    
    // ==========================================
    // 5. AI 信号 (GMGN AI 推荐)
    // ==========================================
    async getAISignals(chain = 'sol') {
        try {
            // 尝试获取 AI 推荐（可能需要特殊端点）
            const url = `${this.config.baseUrl}/signals/${chain}/ai`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            
            if (response.data?.data) {
                return response.data.data;
            }
            return [];
        } catch (error) {
            // AI 端点可能不公开，尝试备用方案
            return this.getAISignalsFallback(chain);
        }
    }
    
    async getAISignalsFallback(chain = 'sol') {
        try {
            // 使用综合评分作为 AI 信号的替代
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/1h`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'score',  // 综合评分
                    direction: 'desc',
                    'filters[]': this.config.safetyFilters
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                // 取评分最高的前10个
                return response.data.data.rank.slice(0, 10);
            }
            return [];
        } catch (error) {
            return [];
        }
    }
    
    // ==========================================
    // 6. 战壕信号 (Trenches - 新币聚合信号)
    // ==========================================
    async getTrenchesTokens(chain = 'sol') {
        try {
            // 战壕 = 新币 + 多维度信号聚合
            // 包含: 即将毕业、已迁移、热门新币等
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/1h`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'open_timestamp',  // 按上线时间排序（新币优先）
                    direction: 'desc',
                    'filters[]': this.config.safetyFilters
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                // 过滤出24小时内的新币，且有一定交易量
                const now = Date.now();
                return response.data.data.rank.filter(t => {
                    const openTime = t.open_timestamp ? t.open_timestamp * 1000 : 0;
                    const age = now - openTime;
                    const isNew = age < 24 * 60 * 60 * 1000; // 24小时内
                    const hasVolume = (t.volume_24h || t.volume || 0) > 5000; // 成交量 > $5000
                    const hasHolders = (t.holder_count || 0) > 50; // 持有人 > 50
                    return isNew && hasVolume && hasHolders;
                });
            }
            return [];
        } catch (error) {
            console.error(`[GMGN] 战壕API错误: ${error.message}`);
            return [];
        }
    }
    
    // ==========================================
    // 7. 热门榜 (Hot - 综合热度排行)
    // ==========================================
    async getHotTokens(chain = 'sol') {
        try {
            // 热门 = 交易量 + 持有人增长 + 社交热度
            const url = `${this.config.baseUrl}/rank/${chain}/swaps/1h`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                params: {
                    orderby: 'swaps',  // 按交易次数排序
                    direction: 'desc',
                    'filters[]': this.config.safetyFilters
                },
                timeout: 15000
            });
            
            if (response.data?.data?.rank) {
                // 取交易最活跃的前15个
                return response.data.data.rank.slice(0, 15);
            }
            return [];
        } catch (error) {
            console.error(`[GMGN] 热门榜API错误: ${error.message}`);
            return [];
        }
    }
    
    // ==========================================
    // 8. 获取代币详情（增强版）
    // ==========================================
    async getTokenDetails(tokenCA, chain = 'sol') {
        try {
            const url = `${this.config.baseUrl}/tokens/${chain}/${tokenCA}`;
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 10000
            });
            
            if (response.data?.data) {
                const data = response.data.data;
                return {
                    token_ca: tokenCA,
                    chain: chain.toUpperCase(),
                    symbol: data.symbol,
                    name: data.name,
                    price: data.price,
                    market_cap: data.market_cap,
                    liquidity: data.liquidity,
                    volume_24h: data.volume_24h,
                    holder_count: data.holder_count,
                    smart_money_count: data.smart_money_count || 0,
                    kol_count: data.kol_count || 0,
                    blue_chip_index: data.blue_chip_index || 0,
                    price_change_5m: data.price_change_5m || 0,
                    price_change_1h: data.price_change_1h || 0,
                    price_change_24h: data.price_change_24h || 0,
                    is_honeypot: data.is_honeypot || false,
                    dex_paid: data.dexscreener_ad || data.is_promoted || false
                };
            }
            return null;
        } catch (error) {
            return null;
        }
    }
    
    // ==========================================
    // 9. 综合扫描
    // ==========================================
    async scanAll(chain = 'sol') {
        const signals = [];
        const { enabledSignals } = this.config;
        
        // 并行获取所有信号
        const [smartMoney, kol, surge, dexPaid, ai, trenches, hot] = await Promise.all([
            enabledSignals.smartMoney ? this.getSmartMoneyTokens(chain) : [],
            enabledSignals.kol ? this.getKOLSignals(chain) : [],
            enabledSignals.trending ? this.getSurgeTokens(chain) : [],
            enabledSignals.dexPaid ? this.getDexPaidTokens(chain) : [],
            enabledSignals.aiSignal ? this.getAISignals(chain) : [],
            enabledSignals.trenches ? this.getTrenchesTokens(chain) : [],
            enabledSignals.hot ? this.getHotTokens(chain) : []
        ]);
        
        // 处理聪明钱信号
        for (const token of smartMoney.slice(0, 10)) {
            const signal = this.createSignal(token, chain, 'smart_money', '🐋');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        // 处理 KOL 信号
        for (const token of kol.slice(0, 5)) {
            const signal = this.createSignal(token, chain, 'kol', '👑');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        // 处理飙升信号
        for (const token of surge.slice(0, 5)) {
            const signal = this.createSignal(token, chain, 'surge', '🚀');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        // 处理 DEX 付费信号
        for (const token of dexPaid.slice(0, 5)) {
            const signal = this.createSignal(token, chain, 'dex_paid', '💎');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        // 处理 AI 信号
        for (const token of ai.slice(0, 5)) {
            const signal = this.createSignal(token, chain, 'ai_signal', '🤖');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        // 处理战壕信号 (新币聚合)
        for (const token of trenches.slice(0, 5)) {
            const signal = this.createSignal(token, chain, 'trenches', '⚔️');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        // 处理热门信号
        for (const token of hot.slice(0, 5)) {
            const signal = this.createSignal(token, chain, 'hot', '🔥');
            if (signal && this.isNewSignal(signal)) {
                signals.push(signal);
            }
        }
        
        return signals;
    }
    
    createSignal(token, chain, signalType, emoji) {
        const tokenCA = token.address || token.token_address || token.ca;
        if (!tokenCA) return null;
        
        return {
            token_ca: tokenCA,
            chain: chain.toUpperCase(),
            symbol: token.symbol || 'Unknown',
            name: token.name || token.symbol || 'Unknown',
            signal_type: signalType,
            emoji: emoji,
            smart_money_count: token.smart_money_count || token.smartmoney || 0,
            kol_count: token.kol_count || token.kol_holders || 0,
            volume_24h: token.volume_24h || token.volume || 0,
            price: token.price || 0,
            price_change_5m: token.price_change_5m || token.change_5m || 0,
            price_change_1h: token.price_change_1h || token.change_1h || 0,
            liquidity: token.liquidity || 0,
            market_cap: token.market_cap || 0,
            holder_count: token.holder_count || 0,
            blue_chip_index: token.blue_chip_index || 0,
            source: `gmgn_${signalType}`,
            timestamp: Date.now()
        };
    }
    
    isNewSignal(signal) {
        const cacheKey = `${signal.chain}:${signal.token_ca}:${signal.signal_type}`;
        if (this.lastSeenTokens.has(cacheKey)) {
            const lastSeen = this.lastSeenTokens.get(cacheKey);
            if (Date.now() - lastSeen < 30 * 60 * 1000) { // 30分钟内不重复
                return false;
            }
        }
        this.lastSeenTokens.set(cacheKey, Date.now());
        return true;
    }
    
    // ==========================================
    // 启动/停止
    // ==========================================
    async start() {
        if (this.isRunning) {
            console.log('[GMGN] 已经在运行中');
            return;
        }
        
        this.isRunning = true;
        console.log('[GMGN] 🚀 启动多维信号监控...');
        
        // 立即执行一次
        await this.pollOnce();
        
        // 设置定时轮询
        for (const chain of this.config.chains) {
            this.pollTimers[chain] = setInterval(async () => {
                if (!this.isRunning) return;
                
                try {
                    const signals = await this.scanAll(chain);
                    
                    for (const signal of signals) {
                        console.log(`[GMGN] ${signal.emoji} ${signal.signal_type.toUpperCase()}: ${signal.symbol} (${signal.chain})`);
                        this.emit('signal', signal);
                    }
                    
                } catch (error) {
                    console.error(`[GMGN] ${chain} 轮询错误:`, error.message);
                }
                
            }, this.config.pollInterval);
        }
        
        console.log('[GMGN] ✅ 多维信号监控已启动');
    }
    
    async pollOnce() {
        for (const chain of this.config.chains) {
            try {
                const signals = await this.scanAll(chain);
                
                for (const signal of signals) {
                    console.log(`[GMGN] ${signal.emoji} ${signal.signal_type.toUpperCase()}: ${signal.symbol} (${signal.chain})`);
                    this.emit('signal', signal);
                }
                
            } catch (error) {
                console.error(`[GMGN] ${chain} 扫描错误:`, error.message);
            }
        }
    }
    
    stop() {
        this.isRunning = false;
        
        for (const chain of Object.keys(this.pollTimers)) {
            if (this.pollTimers[chain]) {
                clearInterval(this.pollTimers[chain]);
                delete this.pollTimers[chain];
            }
        }
        
        console.log('[GMGN] ⏹️ 多维信号监控已停止');
    }
    
    getStatus() {
        return {
            isRunning: this.isRunning,
            chains: this.config.chains,
            enabledSignals: this.config.enabledSignals,
            pollInterval: this.config.pollInterval,
            cachedTokens: this.lastSeenTokens.size
        };
    }
}

export default GMGNSmartMoneyScout;
