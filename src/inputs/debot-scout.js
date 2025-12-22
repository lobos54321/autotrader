/**
 * DeBot Scout - 引擎 A: 猎手侦察模块
 * 
 * 通过 DeBot API 获取聪明钱信号，作为独立触发源
 * 
 * 核心价值：
 * - smart_wallet_online_count: 实时聪明钱数量
 * - safe_info: GoPlus 安全检测（蜜罐、税率）
 * - activity_score: 活跃度评分
 */

import axios from 'axios';
import { EventEmitter } from 'events';

class DeBotScout extends EventEmitter {
    constructor() {
        super();
        
        // DeBot API 配置
        this.config = {
            baseUrl: 'https://debot.ai/api',
            // Cookie 需要定期更新（登录后从浏览器获取）
            cookie: process.env.DEBOT_COOKIE || '',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
            
            // 轮询间隔（毫秒）
            pollInterval: 10000, // 10秒
            
            // 聪明钱触发阈值
            smartMoneyThreshold: {
                online: 2,   // 实时聪明钱 >= 2 触发
                total: 5     // 累计聪明钱 >= 5 加分
            },
            
            // 支持的链
            chains: ['sol', 'bsc']
        };
        
        this.isRunning = false;
        this.lastSeenTokens = new Map(); // 防止重复触发
        this.pollTimers = {};
    }
    
    /**
     * 获取请求头
     */
    getHeaders() {
        return {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'cache-control': 'no-cache',
            'cookie': this.config.cookie,
            'pragma': 'no-cache',
            'referer': 'https://debot.ai/',
            'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': this.config.userAgent
        };
    }
    
    /**
     * 获取 DeBot Feed（热门代币列表）
     */
    async fetchFeed(chain = 'sol') {
        try {
            const requestId = this.generateRequestId();
            const url = `${this.config.baseUrl}/community/signal/feed?request_id=${requestId}&chain=${chain}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            
            if (response.data.code === 0 && response.data.data) {
                return response.data.data;
            }
            
            console.error(`[DeBot] Feed API error: ${response.data.description}`);
            return [];
            
        } catch (error) {
            if (error.response?.status === 401 || error.response?.status === 403) {
                console.error('[DeBot] ⚠️ Cookie 过期，请重新获取！');
            } else {
                console.error(`[DeBot] Feed fetch error: ${error.message}`);
            }
            return [];
        }
    }
    
    /**
     * 生成请求ID
     */
    generateRequestId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    
    /**
     * 解析 DeBot 代币数据为标准信号格式
     */
    parseTokenToSignal(token, chain) {
        const smartMoneyOnline = token.smart_wallet_online_count || 0;
        const smartMoneyTotal = token.smart_wallet_total_count || 0;
        const safeInfo = token.safe_info?.goplus || {};
        
        // 计算聪明钱分数
        let smartMoneyScore = 0;
        if (smartMoneyOnline >= 3) smartMoneyScore = 20;
        else if (smartMoneyOnline >= 2) smartMoneyScore = 15;
        else if (smartMoneyOnline >= 1) smartMoneyScore = 10;
        
        // 累计聪明钱加分
        if (smartMoneyTotal >= 10) smartMoneyScore += 5;
        else if (smartMoneyTotal >= 5) smartMoneyScore += 3;
        
        return {
            // 基础信息
            source: 'DeBot',
            engine: 'scout', // 标记为引擎A信号
            chain: chain.toUpperCase(),
            tokenAddress: token.address,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            
            // 聪明钱数据
            smartMoney: {
                online: smartMoneyOnline,
                total: smartMoneyTotal,
                score: smartMoneyScore
            },
            
            // 安全检测（GoPlus）
            security: {
                isHoneypot: safeInfo.is_honeypot === 1,
                isOpenSource: safeInfo.is_open_source === 1,
                isOwnershipAbandoned: safeInfo.is_ownership_abandoned === 1,
                isPoolLocked: safeInfo.is_pool_locked === 1,
                poolBurnPercent: safeInfo.pool_burn_percent || 0,
                buyTax: safeInfo.buy_tax || 0,
                sellTax: safeInfo.sell_tax || 0
            },
            
            // 市场数据
            market: {
                price: token.market_info?.price || 0,
                marketCap: token.market_info?.mkt_cap || 0,
                liquidity: token.pair_summary_info?.liquidity || 0,
                holders: token.market_info?.holders || 0,
                volume24h: token.market_info?.volume || 0,
                percent5m: token.market_info?.percent_5m || 0,
                percent1h: token.market_info?.percent_1h || 0,
                percent24h: token.market_info?.percent_24h || 0
            },
            
            // DeBot 评分
            activityScore: token.activity_score || 0,
            maxPriceGain: token.max_price_gain || 0,
            
            // 标签
            tags: token.tags || [],
            
            // 社交信息
            twitter: token.social_info?.twitter || null,
            telegram: token.social_info?.telegram || null,
            
            // 时间戳
            timestamp: Date.now(),
            creationTime: token.creation_timestamp ? token.creation_timestamp * 1000 : null
        };
    }
    
    /**
     * 检查是否为有效的猎手信号
     */
    isValidHunterSignal(signal) {
        // 1. 聪明钱阈值检查
        if (signal.smartMoney.online < this.config.smartMoneyThreshold.online) {
            return { valid: false, reason: `聪明钱不足: ${signal.smartMoney.online} < ${this.config.smartMoneyThreshold.online}` };
        }
        
        // 2. 蜜罐检查（一票否决）
        if (signal.security.isHoneypot) {
            return { valid: false, reason: '蜜罐检测: REJECT' };
        }
        
        // 3. 税率检查（BSC < 5%, SOL 通常无税）
        const maxTax = signal.chain === 'BSC' ? 5 : 1;
        if (signal.security.buyTax > maxTax || signal.security.sellTax > maxTax) {
            return { valid: false, reason: `税率过高: Buy ${signal.security.buyTax}%, Sell ${signal.security.sellTax}%` };
        }
        
        // 4. 流动性检查
        const minLiquidity = signal.chain === 'SOL' ? 5000 : 10000;
        if (signal.market.liquidity < minLiquidity) {
            return { valid: false, reason: `流动性不足: $${signal.market.liquidity} < $${minLiquidity}` };
        }
        
        // 5. 权限检查（BSC 必须弃权）
        if (signal.chain === 'BSC' && !signal.security.isOwnershipAbandoned) {
            return { valid: false, reason: '权限未弃: BSC 需要 Ownership Abandoned' };
        }
        
        return { valid: true, reason: 'PASS' };
    }
    
    /**
     * 处理新发现的代币
     */
    async processTokens(tokens, chain) {
        const signals = [];
        
        for (const token of tokens) {
            const tokenKey = `${chain}:${token.address}`;
            
            // 检查是否已处理过（30分钟内不重复）
            const lastSeen = this.lastSeenTokens.get(tokenKey);
            if (lastSeen && Date.now() - lastSeen < 30 * 60 * 1000) {
                continue;
            }
            
            // 解析为标准信号
            const signal = this.parseTokenToSignal(token, chain);
            
            // 验证是否为有效猎手信号
            const validation = this.isValidHunterSignal(signal);
            
            if (validation.valid) {
                // 更新最后看到时间
                this.lastSeenTokens.set(tokenKey, Date.now());
                
                // 标记为猎手触发
                signal.isHunterTrigger = true;
                signal.validationReason = validation.reason;
                
                signals.push(signal);
                
                console.log(`\n🎯 [DeBot Scout] 发现猎手信号!`);
                console.log(`   Token: ${signal.tokenSymbol} (${signal.chain})`);
                console.log(`   聪明钱: 实时 ${signal.smartMoney.online}, 累计 ${signal.smartMoney.total}`);
                console.log(`   流动性: $${signal.market.liquidity.toLocaleString()}`);
                console.log(`   活跃度: ${(signal.activityScore * 100).toFixed(1)}%`);
                
                // 发射信号事件
                this.emit('hunter-signal', signal);
            }
        }
        
        return signals;
    }
    
    /**
     * 轮询单个链
     */
    async pollChain(chain) {
        try {
            const tokens = await this.fetchFeed(chain);
            
            if (tokens.length > 0) {
                await this.processTokens(tokens, chain);
            }
            
        } catch (error) {
            console.error(`[DeBot] Poll ${chain} error:`, error.message);
        }
    }
    
    /**
     * 启动 Scout
     */
    start() {
        if (this.isRunning) {
            console.log('[DeBot] Scout already running');
            return;
        }
        
        if (!this.config.cookie) {
            console.warn('[DeBot] ⚠️ 未配置 DEBOT_COOKIE，Scout 无法启动');
            console.warn('[DeBot] 请在 Zeabur 环境变量中添加 DEBOT_COOKIE');
            return;
        }
        
        this.isRunning = true;
        console.log('\n🔍 [DeBot Scout] 引擎 A 启动');
        console.log(`   轮询间隔: ${this.config.pollInterval / 1000}s`);
        console.log(`   聪明钱阈值: >= ${this.config.smartMoneyThreshold.online} 实时`);
        console.log(`   监控链: ${this.config.chains.join(', ')}`);
        
        // 立即执行一次
        this.config.chains.forEach(chain => this.pollChain(chain));
        
        // 设置定时轮询
        this.config.chains.forEach(chain => {
            this.pollTimers[chain] = setInterval(
                () => this.pollChain(chain),
                this.config.pollInterval
            );
        });
    }
    
    /**
     * 停止 Scout
     */
    stop() {
        this.isRunning = false;
        
        Object.values(this.pollTimers).forEach(timer => {
            if (timer) clearInterval(timer);
        });
        this.pollTimers = {};
        
        console.log('[DeBot Scout] 已停止');
    }
    
    /**
     * 手动查询单个代币
     */
    async queryToken(address, chain = 'sol') {
        const tokens = await this.fetchFeed(chain);
        return tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    }
    
    /**
     * 获取当前热门代币（用于 Dashboard）
     */
    async getHotTokens(chain = 'sol', limit = 10) {
        const tokens = await this.fetchFeed(chain);
        
        // 按聪明钱数量排序
        return tokens
            .sort((a, b) => (b.smart_wallet_online_count || 0) - (a.smart_wallet_online_count || 0))
            .slice(0, limit)
            .map(t => this.parseTokenToSignal(t, chain));
    }
}

// 单例导出
const debotScout = new DeBotScout();

export default debotScout;
export { DeBotScout };
