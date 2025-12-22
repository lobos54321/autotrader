/**
 * DeBot Scout - 引擎 A: 猎手侦察模块
 * 
 * 通过 DeBot API 获取多维度信号数据
 * 
 * API 端点：
 * - /community/signal/channel/heatmap - AI信号列表 + 信号统计
 * - /community/signal/activity/rank - 热门代币排行榜
 * - /v1/nitter/story/latest - AI叙事报告
 * - /community/signal/token/metrics - 代币详细指标
 * 
 * 核心数据：
 * - signal_count: 信号次数
 * - max_price_gain: 最大涨幅倍数
 * - token_level: 代币等级 (bronze/silver/gold)
 * - smart_wallet_count: 聪明钱数量
 * - activity_score: 活跃度分数
 * - AI rating: AI 叙事评分
 */

import axios from 'axios';
import { EventEmitter } from 'events';

class DeBotScout extends EventEmitter {
    constructor() {
        super();
        
        // DeBot API 配置
        this.config = {
            baseUrl: 'https://debot.ai/api',
            cookie: process.env.DEBOT_COOKIE || '',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
            
            // 轮询间隔（毫秒）
            pollInterval: 15000, // 15秒
            
            // 支持的链
            chains: ['solana', 'bsc']
        };
        
        this.isRunning = false;
        this.lastSeenTokens = new Map();
        this.processedSignals = new Set();
        this.pollTimers = {};
        this.aiReportCache = new Map(); // AI报告缓存
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
     * 获取 Activity Rank（热门代币排行榜）
     */
    async fetchActivityRank(chain = 'solana') {
        try {
            const requestId = this.generateRequestId();
            const url = `${this.config.baseUrl}/community/signal/activity/rank?request_id=${requestId}&chain=${chain}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            
            if (response.data.code === 0 && response.data.data) {
                return response.data.data;
            }
            
            return null;
        } catch (error) {
            console.error(`[DeBot] Activity Rank error: ${error.message}`);
            return null;
        }
    }
    
    /**
     * 获取 AI 叙事报告
     */
    async fetchAIReport(tokenAddress) {
        // 检查缓存（1小时有效）
        const cached = this.aiReportCache.get(tokenAddress);
        if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) {
            return cached.data;
        }
        
        try {
            const requestId = this.generateRequestId();
            const url = `${this.config.baseUrl}/v1/nitter/story/latest?request_id=${requestId}&ca_address=${tokenAddress}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            
            if (response.data.code === 0 && response.data.data?.history?.story) {
                const report = response.data.data.history;
                
                // 缓存结果
                this.aiReportCache.set(tokenAddress, {
                    data: report,
                    timestamp: Date.now()
                });
                
                return report;
            }
            
            return null;
        } catch (error) {
            // AI报告可能不存在，不打印错误
            return null;
        }
    }
    
    /**
     * 获取代币详细指标
     */
    async fetchTokenMetrics(tokenAddress, chain = 'solana') {
        try {
            const requestId = this.generateRequestId();
            const url = `${this.config.baseUrl}/community/signal/token/metrics?request_id=${requestId}&chain=${chain}&token=${tokenAddress}`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders(),
                timeout: 15000
            });
            
            if (response.data.code === 0 && response.data.data) {
                return response.data.data;
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }
    
    /**
     * 解析 Heatmap 数据中的信号（保留原始数据，不过滤）
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
                type: 'AI_SIGNAL',
                engine: 'scout',
                chain: chain === 'solana' ? 'SOL' : 'BSC',
                tokenAddress: tokenAddress,
                
                // DeBot 原始信号数据
                signalCount: signalData.signal_count || 0,
                firstTime: signalData.first_time ? new Date(signalData.first_time * 1000) : null,
                firstPrice: signalData.first_price || 0,
                maxPrice: signalData.max_price || 0,
                maxPriceGain: signalData.max_price_gain || 0,
                tokenLevel: signalData.token_level || 'unknown',
                signalTags: signalData.signal_tags || [],
                
                timestamp: Date.now()
            };
            
            signals.push(signal);
        }
        
        return signals;
    }
    
    /**
     * 解析 Activity Rank 数据（热门代币）
     */
    parseActivityRank(data, chain) {
        const tokens = [];
        
        if (!Array.isArray(data)) {
            return tokens;
        }
        
        for (const token of data) {
            tokens.push({
                source: 'DeBot',
                type: 'HOT_TOKEN',
                engine: 'scout',
                chain: chain === 'solana' ? 'SOL' : 'BSC',
                tokenAddress: token.address,
                
                // 基本信息
                name: token.name,
                symbol: token.symbol,
                logo: token.logo,
                
                // 市场数据
                price: token.market_info?.price || 0,
                marketCap: token.market_info?.mkt_cap || 0,
                holders: token.market_info?.holders || 0,
                volume: token.market_info?.volume || 0,
                liquidity: token.pair_summary_info?.liquidity || 0,
                
                // 涨跌幅
                change5m: token.market_info?.percent_5m || 0,
                change1h: token.market_info?.percent_1h || 0,
                change24h: token.market_info?.percent_24h || 0,
                
                // 交易数据
                buys: token.market_info?.buys || 0,
                sells: token.market_info?.sells || 0,
                swaps: token.market_info?.swaps || 0,
                
                // 聪明钱数据 🔥
                smartWalletOnline: token.smart_wallet_online_count || 0,
                smartWalletTotal: token.smart_wallet_total_count || 0,
                maxPriceGain: token.max_price_gain || 0,
                tokenTier: token.token_tier || '',
                activityScore: token.activity_score || 0,
                
                // 社交信息
                twitter: token.social_info?.twitter || '',
                website: token.social_info?.website || '',
                description: token.social_info?.description || '',
                
                // 安全信息
                isMintAbandoned: token.safe_info?.solana?.is_mint_abandoned === 1,
                
                // 标签
                tags: token.tags || [],
                
                timestamp: Date.now()
            });
        }
        
        return tokens;
    }
    
    /**
     * 解析 AI 报告数据
     */
    parseAIReport(report) {
        if (!report?.story) {
            return null;
        }
        
        const story = report.story;
        const storyEn = report.story_en || story;
        
        return {
            projectName: story.project_name,
            contractAddress: story.contract_address,
            
            // 叙事类型
            narrativeType: story.narrative_type,
            
            // 背景起源
            origin: story.background?.origin?.text || '',
            
            // 传播数据
            distribution: {
                celebritySupport: story.distribution?.celebrity_support?.text || '',
                maxViews: story.distribution?.max_views?.text || '',
                maxLikes: story.distribution?.max_likes?.text || '',
                maxComments: story.distribution?.max_comments?.text || '',
                communityParticipation: story.distribution?.community_participation?.text || '',
                negativeIncidents: story.distribution?.negative_incidents?.text || ''
            },
            
            // AI 评分 🔥
            rating: {
                score: parseInt(story.rating?.score) || 0,
                reason: story.rating?.reason || ''
            },
            
            // 英文版评分理由
            ratingReasonEn: storyEn.rating?.reason || '',
            
            // 来源推文
            sourceTweets: report.source_tweets || [],
            
            // 生成时间
            generatedAt: report.generated_at
        };
    }
    
    /**
     * 处理信号并发射事件（不过滤，发送所有信号）
     */
    async processSignals(signals, chain) {
        for (const signal of signals) {
            const signalKey = `${chain}:${signal.tokenAddress}`;
            
            // 检查是否30分钟内已处理
            const lastSeen = this.lastSeenTokens.get(signalKey);
            if (lastSeen && Date.now() - lastSeen < 30 * 60 * 1000) {
                continue;
            }
            
            // 标记已处理
            this.lastSeenTokens.set(signalKey, Date.now());
            this.processedSignals.add(signalKey);
            
            // 尝试获取 AI 报告
            const aiReport = await this.fetchAIReport(signal.tokenAddress);
            if (aiReport) {
                signal.aiReport = this.parseAIReport(aiReport);
            }
            
            console.log(`\n🎯 [DeBot Scout] 发现信号!`);
            console.log(`   Token: ${signal.tokenAddress.slice(0, 8)}... (${signal.chain})`);
            console.log(`   等级: ${signal.tokenLevel || 'N/A'}`);
            console.log(`   信号次数: ${signal.signalCount}`);
            console.log(`   最大涨幅: ${(signal.maxPriceGain || 0).toFixed(1)}x`);
            if (signal.aiReport?.rating?.score) {
                console.log(`   AI评分: ${signal.aiReport.rating.score}/10`);
            }
            
            // 发射信号事件
            this.emit('hunter-signal', signal);
        }
        
        return signals;
    }
    
    /**
     * 处理热门代币数据
     */
    async processHotTokens(tokens, chain) {
        for (const token of tokens) {
            const signalKey = `hot:${chain}:${token.tokenAddress}`;
            
            // 检查是否5分钟内已处理
            const lastSeen = this.lastSeenTokens.get(signalKey);
            if (lastSeen && Date.now() - lastSeen < 5 * 60 * 1000) {
                continue;
            }
            
            // 标记已处理
            this.lastSeenTokens.set(signalKey, Date.now());
            
            // 尝试获取 AI 报告（只对有聪明钱的代币）
            if (token.smartWalletTotal > 0) {
                const aiReport = await this.fetchAIReport(token.tokenAddress);
                if (aiReport) {
                    token.aiReport = this.parseAIReport(aiReport);
                }
            }
            
            // 发射热门代币事件
            this.emit('hot-token', token);
        }
        
        return tokens;
    }
    
    /**
     * 轮询单个链
     */
    async pollChain(chain) {
        try {
            // 1. 获取 Heatmap 信号
            const heatmapData = await this.fetchHeatmap(chain);
            if (heatmapData) {
                const signals = this.parseHeatmapSignals(heatmapData, chain);
                if (signals.length > 0) {
                    console.log(`[DeBot Scout] ${chain} Heatmap: ${signals.length} 个信号`);
                    await this.processSignals(signals, chain);
                }
            }
            
            // 2. 获取 Activity Rank 热门代币
            const rankData = await this.fetchActivityRank(chain);
            if (rankData) {
                const hotTokens = this.parseActivityRank(rankData, chain);
                if (hotTokens.length > 0) {
                    console.log(`[DeBot Scout] ${chain} Rank: ${hotTokens.length} 个热门代币`);
                    await this.processHotTokens(hotTokens, chain);
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
            console.warn('[DeBot] 请在环境变量中添加 DEBOT_COOKIE');
            return;
        }
        
        this.isRunning = true;
        console.log('\n🔍 [DeBot Scout] 引擎 A 启动');
        console.log(`   轮询间隔: ${this.config.pollInterval / 1000}s`);
        console.log(`   监控链: ${this.config.chains.join(', ')}`);
        console.log(`   数据源: Heatmap + ActivityRank + AI Report`);
        
        // 立即执行一次
        this.config.chains.forEach(chain => this.pollChain(chain));
        
        // 设置定时轮询
        this.config.chains.forEach(chain => {
            this.pollTimers[chain] = setInterval(
                () => this.pollChain(chain),
                this.config.pollInterval
            );
        });
        
        // 定期清理缓存
        this.cleanupTimer = setInterval(() => this.cleanupCache(), 30 * 60 * 1000);
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
        
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        
        console.log('[DeBot Scout] 已停止');
    }
    
    /**
     * 获取当前热门代币（用于 Dashboard）
     */
    async getHotTokens(chain = 'solana', limit = 20) {
        const rankData = await this.fetchActivityRank(chain);
        
        if (!rankData) {
            return [];
        }
        
        const tokens = this.parseActivityRank(rankData, chain);
        return tokens.slice(0, limit);
    }
    
    /**
     * 获取代币完整信息（包含 AI 报告）
     */
    async getTokenInfo(tokenAddress, chain = 'solana') {
        const [metrics, aiReport] = await Promise.all([
            this.fetchTokenMetrics(tokenAddress, chain),
            this.fetchAIReport(tokenAddress)
        ]);
        
        return {
            tokenAddress,
            chain,
            metrics: metrics || null,
            aiReport: aiReport ? this.parseAIReport(aiReport) : null
        };
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
        
        // 清理 AI 报告缓存
        for (const [key, cached] of this.aiReportCache) {
            if (now - cached.timestamp > expireTime) {
                this.aiReportCache.delete(key);
            }
        }
    }
}

// 单例导出
const debotScout = new DeBotScout();

export default debotScout;
export { DeBotScout };
