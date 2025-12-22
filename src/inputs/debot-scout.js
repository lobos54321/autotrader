/**
 * DeBot Scout - 引擎 A: 猎手侦察模块
 * 
 * 通过 DeBot Heatmap API 获取聪明钱信号，作为独立触发源
 * 
 * 核心价值：
 * - signal_count: 信号次数（多少聪明钱买入）
 * - max_price_gain: 最大涨幅倍数
 * - token_level: 代币等级 (bronze/silver/gold)
 * - heatmap: 热力图时间线
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
            pollInterval: 15000, // 15秒（防止 Cloudflare 限流）
            
            // 信号触发阈值
            signalThreshold: {
                minSignalCount: 2,   // 最少 2 次信号
                minGain: 2.0,        // 最小涨幅 2x
                // 代币等级权重
                levelWeight: {
                    'gold': 30,
                    'silver': 20,
                    'bronze': 10
                }
            },
            
            // 支持的链
            chains: ['solana', 'bsc']
        };
        
        this.isRunning = false;
        this.lastSeenTokens = new Map(); // 防止重复触发
        this.processedSignals = new Set(); // 已处理的信号
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
     * 获取 DeBot Heatmap（热力图 + 信号列表）
     */
    async fetchHeatmap(chain = 'solana') {
        try {
            const requestId = this.generateRequestId();
            const url = `${this.config.baseUrl}/community/signal/channel/heatmap?request_id=${requestId}&chain=${chain}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            
            if (response.data.code === 0 && response.data.data) {
                return response.data.data;
            }
            
            console.error(`[DeBot] Heatmap API error: ${response.data.description}`);
            return null;
            
        } catch (error) {
            if (error.response?.status === 401 || error.response?.status === 403) {
                console.error('[DeBot] ⚠️ Cookie 过期，请重新获取！');
            } else {
                console.error(`[DeBot] Heatmap fetch error: ${error.message}`);
            }
            return null;
        }
    }
    
    /**
     * 解析 Heatmap 数据中的信号
     */
    parseHeatmapSignals(data, chain) {
        const signals = [];
        
        if (!data?.meta?.signals) {
            return signals;
        }
        
        const signalsMap = data.meta.signals;
        
        for (const [tokenAddress, signalData] of Object.entries(signalsMap)) {
            // 检查是否已处理
            const signalKey = `${chain}:${tokenAddress}`;
            if (this.processedSignals.has(signalKey)) {
                continue;
            }
            
            const signal = {
                source: 'DeBot',
                type: 'SMART_MONEY',
                engine: 'scout',
                chain: chain === 'solana' ? 'SOL' : 'BSC',
                tokenAddress: tokenAddress,
                
                // DeBot 信号数据
                signalCount: signalData.signal_count || 0,
                firstTime: signalData.first_time ? new Date(signalData.first_time * 1000) : null,
                firstPrice: signalData.first_price || 0,
                maxPrice: signalData.max_price || 0,
                maxPriceGain: signalData.max_price_gain || 0,  // 🔥 涨幅倍数
                tokenLevel: signalData.token_level || 'bronze', // bronze/silver/gold
                signalTags: signalData.signal_tags || [],
                
                // 计算分数
                score: this.calculateSignalScore(signalData),
                
                timestamp: Date.now()
            };
            
            signals.push(signal);
        }
        
        return signals;
    }
    
    /**
     * 计算信号分数
     */
    calculateSignalScore(signalData) {
        let score = 0;
        
        // 信号次数分数 (每次信号 +5 分，最多 30 分)
        score += Math.min(signalData.signal_count * 5, 30);
        
        // 涨幅分数 (每倍 +10 分，最多 50 分)
        score += Math.min(Math.floor(signalData.max_price_gain || 0) * 10, 50);
        
        // 代币等级分数
        const levelWeight = this.config.signalThreshold.levelWeight;
        score += levelWeight[signalData.token_level] || 0;
        
        return score;
    }
    
    /**
     * 检查是否为有效的猎手信号
     */
    isValidHunterSignal(signal) {
        // 1. 信号次数检查
        if (signal.signalCount < this.config.signalThreshold.minSignalCount) {
            return { 
                valid: false, 
                reason: `信号次数不足: ${signal.signalCount} < ${this.config.signalThreshold.minSignalCount}` 
            };
        }
        
        // 2. 涨幅检查（可选，太高可能已经错过）
        // if (signal.maxPriceGain > 20) {
        //     return { valid: false, reason: `涨幅过高已错过: ${signal.maxPriceGain.toFixed(1)}x` };
        // }
        
        // 3. 代币等级检查（至少 bronze）
        if (!['bronze', 'silver', 'gold'].includes(signal.tokenLevel)) {
            return { valid: false, reason: `代币等级未知: ${signal.tokenLevel}` };
        }
        
        // Gold 级别代币直接通过
        if (signal.tokenLevel === 'gold') {
            return { valid: true, reason: `🏆 GOLD 级别代币！${signal.signalCount} 次信号，${signal.maxPriceGain.toFixed(1)}x 涨幅` };
        }
        
        // Silver 级别需要 3+ 信号
        if (signal.tokenLevel === 'silver' && signal.signalCount >= 3) {
            return { valid: true, reason: `🥈 SILVER 级别，${signal.signalCount} 次信号，${signal.maxPriceGain.toFixed(1)}x 涨幅` };
        }
        
        // Bronze 级别需要 5+ 信号且有涨幅
        if (signal.tokenLevel === 'bronze' && signal.signalCount >= 5 && signal.maxPriceGain >= 2) {
            return { valid: true, reason: `🥉 BRONZE 级别，${signal.signalCount} 次信号，${signal.maxPriceGain.toFixed(1)}x 涨幅` };
        }
        
        return { 
            valid: true, // 先放宽，让后续引擎过滤
            reason: `${signal.tokenLevel.toUpperCase()}: ${signal.signalCount} 信号, ${signal.maxPriceGain.toFixed(1)}x` 
        };
    }
    
    /**
     * 处理信号并发射事件
     */
    async processSignals(signals, chain) {
        const validSignals = [];
        
        for (const signal of signals) {
            const signalKey = `${chain}:${signal.tokenAddress}`;
            
            // 检查是否30分钟内已处理
            const lastSeen = this.lastSeenTokens.get(signalKey);
            if (lastSeen && Date.now() - lastSeen < 30 * 60 * 1000) {
                continue;
            }
            
            // 验证信号
            const validation = this.isValidHunterSignal(signal);
            
            if (validation.valid) {
                // 标记已处理
                this.lastSeenTokens.set(signalKey, Date.now());
                this.processedSignals.add(signalKey);
                
                signal.isHunterTrigger = true;
                signal.validationReason = validation.reason;
                
                validSignals.push(signal);
                
                console.log(`\n🎯 [DeBot Scout] 发现猎手信号!`);
                console.log(`   Token: ${signal.tokenAddress.slice(0, 8)}... (${signal.chain})`);
                console.log(`   等级: ${signal.tokenLevel.toUpperCase()}`);
                console.log(`   信号次数: ${signal.signalCount}`);
                console.log(`   最大涨幅: ${signal.maxPriceGain.toFixed(1)}x`);
                console.log(`   评分: ${signal.score}`);
                
                // 发射信号事件
                this.emit('hunter-signal', signal);
            }
        }
        
        return validSignals;
    }
    
    /**
     * 轮询单个链
     */
    async pollChain(chain) {
        try {
            const data = await this.fetchHeatmap(chain);
            
            if (data) {
                const signals = this.parseHeatmapSignals(data, chain);
                
                if (signals.length > 0) {
                    console.log(`[DeBot Scout] ${chain} 获取到 ${signals.length} 个信号`);
                    await this.processSignals(signals, chain);
                }
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
        console.log(`   最小信号次数: >= ${this.config.signalThreshold.minSignalCount}`);
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
     * 获取当前热门代币（用于 Dashboard）
     */
    async getHotTokens(chain = 'solana', limit = 10) {
        const data = await this.fetchHeatmap(chain);
        
        if (!data?.meta?.signals) {
            return [];
        }
        
        const signals = this.parseHeatmapSignals(data, chain);
        
        // 按分数排序
        return signals
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
    
    /**
     * 清理过期缓存
     */
    cleanupCache() {
        const now = Date.now();
        const expireTime = 60 * 60 * 1000; // 1小时
        
        for (const [key, time] of this.lastSeenTokens) {
            if (now - time > expireTime) {
                this.lastSeenTokens.delete(key);
                this.processedSignals.delete(key);
            }
        }
    }
}

// 单例导出
const debotScout = new DeBotScout();

export default debotScout;
export { DeBotScout };
