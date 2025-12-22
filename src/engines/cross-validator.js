/**
 * Cross Validator - 交叉验证引擎
 * 
 * 核心逻辑：DeBot 为主（事实层），Telegram 为辅（情绪层）
 * 
 * 漏斗流程：
 * 1. Activity Rank (3-5秒轮询) → 发现新信号
 * 2. 第一层本地过滤 → 聪明钱/流动性/安全性
 * 3. 第二层API调用 → AI Report 叙事评分
 * 4. 第三层交叉验证 → Telegram DB 热度查询
 * 5. 综合评分决策 → Watch / Buy / Ignore
 * 
 * 评分公式 (满分100)：
 * - 聪明钱 40%: min(smartWalletOnline × 10, 40)
 * - AI叙事 30%: rating.score × 3
 * - TG共识 20%: min(频道数 × 5, 20) + Tier1加成
 * - 安全性 10%: 非蜜罐+权限丢弃=10分
 */

import { EventEmitter } from 'events';
import debotScout from '../inputs/debot-scout.js';
import signalDatabase from '../database/signal-database.js';

class CrossValidator extends EventEmitter {
    constructor() {
        super();
        
        // 评分配置
        this.scoringConfig = {
            // 权重
            weights: {
                smartMoney: 40,      // 聪明钱权重 40%
                narrative: 30,       // AI叙事权重 30%
                telegram: 20,        // TG共识权重 20%
                safety: 10           // 安全性权重 10%
            },
            
            // 阈值
            thresholds: {
                watch: 50,           // 观察线
                buy: 70,             // 买入线
                maxBuy: 90           // 重仓线
            },
            
            // 仓位配置 (SOL)
            positions: {
                small: 0.05,         // 小仓
                normal: 0.15,        // 中仓
                max: 0.2             // 大仓
            }
        };
        
        // Hard Gates 配置
        this.hardGates = {
            minSmartWalletOnline: 2,       // 最少聪明钱数量
            minLiquidity: 10000,            // 最低流动性 $10k
            minAIScore: 3,                  // 最低AI评分
            requireMintAbandoned: true,     // SOL 必须丢弃权限
            bannedKeywords: ['scam', 'rug', 'honeypot', 'fake', '欺诈', '骗局']
        };
        
        // 状态
        this.isRunning = false;
        this.pendingValidation = new Map();
        this.validatedTokens = new Map();
        
        // Tier 1 频道列表（需要配置）
        this.tier1Channels = new Set([
            // 添加 Tier 1 频道ID
        ]);
    }
    
    /**
     * 初始化并绑定 DeBot Scout 事件
     */
    init() {
        // 监听 DeBot 热门代币事件
        debotScout.on('hot-token', async (token) => {
            await this.onNewToken(token);
        });
        
        // 监听 DeBot 信号事件
        debotScout.on('hunter-signal', async (signal) => {
            await this.onNewSignal(signal);
        });
        
        console.log('[CrossValidator] 初始化完成，已绑定 DeBot Scout 事件');
    }
    
    /**
     * 处理新代币（来自 Activity Rank）
     */
    async onNewToken(token) {
        try {
            // === 第一层：本地 Hard Gates 过滤 ===
            const gateResult = this.checkHardGates(token);
            if (!gateResult.passed) {
                console.log(`[Gate] ❌ ${token.symbol || token.tokenAddress.slice(0,8)}: ${gateResult.reason}`);
                return;
            }
            
            console.log(`\n[Validator] 🔍 开始验证: ${token.symbol} (${token.tokenAddress.slice(0,8)}...)`);
            
            // === 第二层：获取 AI Report ===
            let aiReport = token.aiReport;
            if (!aiReport) {
                aiReport = await debotScout.fetchAIReport(token.tokenAddress);
                if (aiReport) {
                    aiReport = debotScout.parseAIReport(aiReport);
                }
            }
            
            // 检查 AI 评分
            const aiScore = aiReport?.rating?.score || 0;
            if (aiScore < this.hardGates.minAIScore) {
                console.log(`[Gate] ❌ ${token.symbol}: AI评分太低 (${aiScore}/${this.hardGates.minAIScore})`);
                return;
            }
            
            // 检查负面标记
            if (aiReport?.distribution?.negativeIncidents) {
                const negative = aiReport.distribution.negativeIncidents.toLowerCase();
                for (const keyword of this.hardGates.bannedKeywords) {
                    if (negative.includes(keyword)) {
                        console.log(`[Gate] ❌ ${token.symbol}: 有负面标记 (${keyword})`);
                        return;
                    }
                }
            }
            
            // === 第三层：Telegram 交叉验证 ===
            const tgHeat = await this.getTelegramHeat(token.tokenAddress);
            
            // === 综合评分 ===
            const score = this.calculateScore(token, aiReport, tgHeat);
            
            // === 做出决策 ===
            const decision = this.makeDecision(token, aiReport, tgHeat, score);
            
            // 记录验证结果
            this.validatedTokens.set(token.tokenAddress, {
                token,
                aiReport,
                tgHeat,
                score,
                decision,
                timestamp: Date.now()
            });
            
            // 打印结果
            this.printValidationResult(token, aiReport, tgHeat, score, decision);
            
            // 发射决策事件
            if (decision.action !== 'IGNORE') {
                this.emit('validated-signal', {
                    token,
                    aiReport,
                    tgHeat,
                    score,
                    decision
                });
            }
            
        } catch (error) {
            console.error(`[Validator] 验证错误: ${error.message}`);
        }
    }
    
    /**
     * 处理新信号（来自 Heatmap）
     */
    async onNewSignal(signal) {
        // 信号转换为统一格式后验证
        const token = {
            tokenAddress: signal.tokenAddress,
            chain: signal.chain,
            symbol: signal.tokenAddress.slice(0, 8),
            signalCount: signal.signalCount,
            maxPriceGain: signal.maxPriceGain,
            tokenLevel: signal.tokenLevel,
            smartWalletOnline: signal.signalCount || 0, // 用信号次数近似
            liquidity: 0, // 需要额外获取
            isMintAbandoned: true, // 假设安全
            aiReport: signal.aiReport
        };
        
        // 获取更多市场数据
        const metrics = await debotScout.fetchTokenMetrics(signal.tokenAddress, 
            signal.chain === 'SOL' ? 'solana' : 'bsc');
        
        if (metrics) {
            token.liquidity = metrics.liquidity || 0;
            token.price = metrics.price || 0;
            token.marketCap = metrics.mkt_cap || 0;
            token.holders = metrics.holders || 0;
        }
        
        // 进入验证流程
        await this.onNewToken(token);
    }
    
    /**
     * 第一层：Hard Gates 检查
     */
    checkHardGates(token) {
        // 检查聪明钱数量
        if ((token.smartWalletOnline || 0) < this.hardGates.minSmartWalletOnline) {
            return { 
                passed: false, 
                reason: `聪明钱不足 (${token.smartWalletOnline || 0}/${this.hardGates.minSmartWalletOnline})` 
            };
        }
        
        // 检查流动性
        if ((token.liquidity || 0) < this.hardGates.minLiquidity) {
            return { 
                passed: false, 
                reason: `流动性不足 ($${(token.liquidity || 0).toFixed(0)}/$${this.hardGates.minLiquidity})` 
            };
        }
        
        // 检查权限（SOL 链）
        if (this.hardGates.requireMintAbandoned && 
            token.chain === 'SOL' && 
            token.isMintAbandoned === false) {
            return { 
                passed: false, 
                reason: '未丢弃 Mint 权限' 
            };
        }
        
        return { passed: true };
    }
    
    /**
     * 第三层：获取 Telegram 热度
     */
    async getTelegramHeat(tokenAddress) {
        try {
            // 查询过去60分钟内的 Telegram 提及
            const timeWindow = 60 * 60 * 1000; // 60分钟
            const since = Date.now() - timeWindow;
            
            // 从数据库查询
            const mentions = await signalDatabase.getTokenMentions(tokenAddress, since);
            
            if (!mentions || mentions.length === 0) {
                return {
                    mentionCount: 0,
                    channelCount: 0,
                    tier1Count: 0,
                    channels: []
                };
            }
            
            // 统计频道数
            const channels = new Set();
            let tier1Count = 0;
            
            for (const mention of mentions) {
                channels.add(mention.channel_id);
                if (this.tier1Channels.has(mention.channel_id)) {
                    tier1Count++;
                }
            }
            
            return {
                mentionCount: mentions.length,
                channelCount: channels.size,
                tier1Count,
                channels: Array.from(channels)
            };
            
        } catch (error) {
            // 数据库查询失败时返回空数据
            return {
                mentionCount: 0,
                channelCount: 0,
                tier1Count: 0,
                channels: []
            };
        }
    }
    
    /**
     * 计算综合评分
     */
    calculateScore(token, aiReport, tgHeat) {
        const w = this.scoringConfig.weights;
        
        // 1. 聪明钱分数 (40%)
        const smartMoneyScore = Math.min((token.smartWalletOnline || 0) * 10, w.smartMoney);
        
        // 2. AI 叙事分数 (30%)
        const aiScore = aiReport?.rating?.score || 0;
        const narrativeScore = aiScore * 3; // 1-10分 × 3 = 最高30分
        
        // 3. TG 共识分数 (20%)
        let tgScore = Math.min((tgHeat.channelCount || 0) * 5, w.telegram);
        // Tier 1 加成
        if (tgHeat.tier1Count > 0) {
            tgScore = Math.min(tgScore + 2, w.telegram);
        }
        
        // 4. 安全性分数 (10%)
        let safetyScore = 0;
        if (token.isMintAbandoned !== false) {
            safetyScore += 5;
        }
        // 流动性足够也加分
        if ((token.liquidity || 0) >= this.hardGates.minLiquidity) {
            safetyScore += 5;
        }
        safetyScore = Math.min(safetyScore, w.safety);
        
        // 总分
        const totalScore = smartMoneyScore + narrativeScore + tgScore + safetyScore;
        
        return {
            total: Math.round(totalScore),
            breakdown: {
                smartMoney: smartMoneyScore,
                narrative: narrativeScore,
                telegram: tgScore,
                safety: safetyScore
            }
        };
    }
    
    /**
     * 做出决策
     */
    makeDecision(token, aiReport, tgHeat, score) {
        const thresholds = this.scoringConfig.thresholds;
        const positions = this.scoringConfig.positions;
        
        // 低于观察线 → 忽略
        if (score.total < thresholds.watch) {
            return {
                action: 'IGNORE',
                reason: `评分不足 (${score.total}/${thresholds.watch})`,
                position: 0
            };
        }
        
        // 观察区间
        if (score.total < thresholds.buy) {
            return {
                action: 'WATCH',
                reason: `进入观察 (${score.total}分)`,
                position: 0
            };
        }
        
        // 买入区间
        let position = positions.small;
        let tier = 'SCOUT';
        
        if (score.total >= thresholds.maxBuy) {
            // 顶级局
            position = positions.max;
            tier = 'MAX';
        } else if (score.total >= 80) {
            // 共识局
            position = positions.normal;
            tier = 'TREND';
        } else {
            // 早鸟局
            position = positions.small;
            tier = 'SCOUT';
        }
        
        // 根据 TG 热度调整
        if (tgHeat.channelCount > 0 && tier === 'SCOUT') {
            tier = 'TREND';
            position = positions.normal;
        }
        
        return {
            action: 'BUY',
            tier,
            reason: this.getDecisionReason(token, aiReport, tgHeat, score),
            position
        };
    }
    
    /**
     * 生成决策理由
     */
    getDecisionReason(token, aiReport, tgHeat, score) {
        const reasons = [];
        
        if ((token.smartWalletOnline || 0) >= 3) {
            reasons.push(`${token.smartWalletOnline}个聪明钱`);
        }
        
        if (aiReport?.rating?.score >= 7) {
            reasons.push(`AI评分${aiReport.rating.score}分`);
        }
        
        if (tgHeat.channelCount > 0) {
            reasons.push(`${tgHeat.channelCount}个TG频道`);
        }
        
        if (tgHeat.tier1Count > 0) {
            reasons.push('Tier1背书');
        }
        
        return reasons.join(' + ') || `综合评分${score.total}分`;
    }
    
    /**
     * 打印验证结果
     */
    printValidationResult(token, aiReport, tgHeat, score, decision) {
        const symbol = token.symbol || token.tokenAddress.slice(0, 8);
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`📊 [CrossValidator] 验证结果: ${symbol}`);
        console.log(`${'='.repeat(50)}`);
        
        // 基础信息
        console.log(`📍 地址: ${token.tokenAddress}`);
        console.log(`⛓️  链: ${token.chain}`);
        console.log(`💰 流动性: $${(token.liquidity || 0).toLocaleString()}`);
        
        // 分数明细
        console.log(`\n📈 评分明细 (总分: ${score.total}/100):`);
        console.log(`   聪明钱: ${score.breakdown.smartMoney}/40 (${token.smartWalletOnline || 0}个在线)`);
        console.log(`   AI叙事: ${score.breakdown.narrative}/30 (评分${aiReport?.rating?.score || 0}/10)`);
        console.log(`   TG共识: ${score.breakdown.telegram}/20 (${tgHeat.channelCount}个频道)`);
        console.log(`   安全性: ${score.breakdown.safety}/10`);
        
        // 决策
        const actionEmoji = {
            'BUY': '🟢',
            'WATCH': '🟡',
            'IGNORE': '⚫'
        };
        
        console.log(`\n🎯 决策: ${actionEmoji[decision.action]} ${decision.action}`);
        if (decision.tier) {
            console.log(`   等级: ${decision.tier}`);
        }
        console.log(`   理由: ${decision.reason}`);
        if (decision.position > 0) {
            console.log(`   仓位: ${decision.position} SOL`);
        }
        
        console.log(`${'='.repeat(50)}\n`);
    }
    
    /**
     * 启动验证器
     */
    start() {
        if (this.isRunning) {
            console.log('[CrossValidator] 已在运行中');
            return;
        }
        
        this.isRunning = true;
        this.init();
        
        console.log('\n🔄 [CrossValidator] 交叉验证引擎启动');
        console.log(`   Hard Gates:`);
        console.log(`     - 最少聪明钱: ${this.hardGates.minSmartWalletOnline}`);
        console.log(`     - 最低流动性: $${this.hardGates.minLiquidity}`);
        console.log(`     - 最低AI评分: ${this.hardGates.minAIScore}`);
        console.log(`   评分阈值:`);
        console.log(`     - 观察线: ${this.scoringConfig.thresholds.watch}分`);
        console.log(`     - 买入线: ${this.scoringConfig.thresholds.buy}分`);
        console.log(`     - 重仓线: ${this.scoringConfig.thresholds.maxBuy}分`);
    }
    
    /**
     * 停止验证器
     */
    stop() {
        this.isRunning = false;
        console.log('[CrossValidator] 已停止');
    }
    
    /**
     * 获取验证统计
     */
    getStats() {
        const validated = Array.from(this.validatedTokens.values());
        
        return {
            totalValidated: validated.length,
            buySignals: validated.filter(v => v.decision.action === 'BUY').length,
            watchSignals: validated.filter(v => v.decision.action === 'WATCH').length,
            ignoredSignals: validated.filter(v => v.decision.action === 'IGNORE').length,
            avgScore: validated.length > 0 
                ? validated.reduce((sum, v) => sum + v.score.total, 0) / validated.length 
                : 0
        };
    }
}

// 单例导出
const crossValidator = new CrossValidator();

export default crossValidator;
export { CrossValidator };
