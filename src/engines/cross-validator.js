/**
 * Cross Validator - 交叉验证引擎 v2.0
 * 
 * 核心逻辑：DeBot 为主（事实层），Telegram 为辅（情绪层），LLM 做二次验证
 * 
 * 漏斗流程：
 * 1. Activity Rank (3-5秒轮询) → 发现新信号
 * 2. 第一层本地过滤 → 聪明钱/流动性/安全性 (Hard Gates)
 * 3. 第二层API调用 → DeBot AI Report 叙事评分
 * 4. 第三层LLM分析 → Grok 二次验证叙事质量 (可选)
 * 5. 第四层交叉验证 → Telegram DB 热度查询
 * 6. 综合评分决策 → Watch / Buy / Ignore
 * 
 * 评分公式 v2.0 (满分100)：
 * - 聪明钱 40%: min(smartWalletOnline × 10, 40)
 * - AI叙事 25%: DeBot基础(20) + LLM调节(±5)
 * - TG共识 15%: min(频道数 × 5, 15) + Tier1加成
 * - 报警动量 10%: signalCount 黄金区间
 * - 安全性 10%: 权限丢弃(5) + 流动性(5)
 */

import { EventEmitter } from 'events';
import debotScout from '../inputs/debot-scout.js';
import signalDatabase from '../database/signal-database.js';
import aiAnalyst from '../utils/ai-analyst.js';
import GrokTwitterClient from '../social/grok-twitter-client.js';

class CrossValidator extends EventEmitter {
    constructor() {
        super();
        
        // 评分配置 v2.0 - AI增强版
        this.scoringConfig = {
            // 权重 (总计100%)
            weights: {
                smartMoney: 40,      // 聪明钱权重 40%
                narrative: 25,       // AI叙事权重 25% (DeBot 20% + LLM调节 ±5%)
                telegram: 15,        // TG共识权重 15%
                signalMomentum: 10,  // 报警动量权重 10% (新增)
                safety: 10           // 安全性权重 10%
            },
            
            // 阈值
            thresholds: {
                ignore: 50,          // 忽略线
                watch: 55,           // 观察线
                buySmall: 55,        // 小仓买入线
                buyNormal: 70,       // 标准买入线
                buyMax: 80           // 重仓线
            },
            
            // 仓位配置 (SOL)
            positions: {
                small: 0.05,         // 小仓
                normal: 0.15,        // 中仓
                max: 0.20            // 大仓
            },
            
            // 报警动量"黄金区间"配置
            signalMomentum: {
                goldenMin: 2,        // 黄金区起点
                goldenMax: 15,       // 黄金区终点
                crowdedMax: 30,      // 拥挤区终点
                overheat: 50         // 过热阈值 (强制降级)
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
        
        // 可选：X/Twitter 边界复核（默认关闭）
        this.twitterEdgeEnabled = process.env.TWITTER_EDGE_CHECK_ENABLED === 'true';
        this.twitterEdgeTimeoutMs = parseInt(process.env.TWITTER_EDGE_CHECK_TIMEOUT_MS || '2500', 10);
        this.grokTwitterClient = null;

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
            
            // === 第二层：获取 DeBot AI Report ===
            let aiReport = token.aiReport;
            if (!aiReport) {
                aiReport = await debotScout.fetchAIReport(token.tokenAddress);
                if (aiReport) {
                    aiReport = debotScout.parseAIReport(aiReport);
                }
            }
            
            // 检查 DeBot AI 评分
            const debotScore = aiReport?.rating?.score || 0;
            if (debotScore < this.hardGates.minAIScore) {
                console.log(`[Gate] ❌ ${token.symbol}: DeBot评分太低 (${debotScore}/${this.hardGates.minAIScore})`);
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
            
            // === 第三层：LLM 叙事深度分析 (可选) ===
            let llmResult = null;
            if (process.env.AI_ANALYSIS_ENABLED === 'true') {
                const analysisData = aiAnalyst.prepareData(token, aiReport, null);
                llmResult = await aiAnalyst.evaluate(analysisData);
            }
            
            // === 第四层：Telegram 交叉验证 ===
            const tgHeat = await this.getTelegramHeat(token.tokenAddress);
            
            // === 综合评分 (传入 LLM 结果) ===
            const score = this.calculateScore(token, aiReport, tgHeat, llmResult);
            
            // === 可选：X/Twitter 边界复核（仅 55-70 分区间） ===
            if (this.twitterEdgeEnabled && score.total >= this.scoringConfig.thresholds.buySmall && score.total < this.scoringConfig.thresholds.buyNormal) {
                const xCheck = await this.runTwitterEdgeCheck(token);
                score.xRisk = xCheck.risk;
                score.xSummary = xCheck.summary;
                score.xMentions = xCheck.mentions;
                if (xCheck.risk === 'HIGH') {
                    console.log(`⚠️ X边界复核: HIGH - ${xCheck.summary}`);
                } else {
                    console.log(`✅ X边界复核: OK - ${xCheck.summary}`);
                }
            }
            
            // === 做出决策 ===
            const decision = this.makeDecision(token, aiReport, tgHeat, score);
            
            // 记录验证结果
            this.validatedTokens.set(token.tokenAddress, {
                token,
                aiReport,
                tgHeat,
                llmResult,
                score,
                decision,
                timestamp: Date.now()
            });
            
            // 打印结果
            this.printValidationResult(token, aiReport, tgHeat, score, decision, llmResult);
            
            // 发射决策事件
            if (decision.action !== 'IGNORE') {
                this.emit('validated-signal', {
                    token,
                    aiReport,
                    tgHeat,
                    llmResult,
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
     * X/Twitter 边界复核：只在接近阈值时调用一次（省钱+提速）
     */
    async runTwitterEdgeCheck(token) {
        try {
            if (!process.env.XAI_API_KEY) {
                return { risk: 'UNKNOWN', summary: 'XAI_API_KEY未配置', mentions: 0 };
            }

            if (!this.grokTwitterClient) {
                this.grokTwitterClient = new GrokTwitterClient();
            }

            const symbol = token.symbol || token.tokenAddress.slice(0, 8);
            const ca = token.tokenAddress;

            const result = await Promise.race([
                this.grokTwitterClient.searchToken(symbol, ca, 30),
                new Promise((_, reject) => setTimeout(() => reject(new Error('X edge check timeout')), this.twitterEdgeTimeoutMs))
            ]);

            const mentions = result?.mention_count || 0;
            const origin = result?.origin_source;
            const riskFlags = Array.isArray(result?.risk_flags) ? result.risk_flags : [];

            // 简单规则：低提及 + 不真实/风险标记 → HIGH
            if (mentions < 2) {
                return { risk: 'HIGH', summary: `提及过少(${mentions})`, mentions };
            }
            if (origin && origin.is_authentic === false) {
                return { risk: 'HIGH', summary: `源头可疑(${origin.type || 'unknown'})`, mentions };
            }
            if (riskFlags.length > 0) {
                return { risk: 'HIGH', summary: `风险标记:${riskFlags.slice(0, 2).join(',')}`, mentions };
            }

            return { risk: 'LOW', summary: `提及${mentions}，未见明显风险`, mentions };

        } catch (e) {
            return { risk: 'UNKNOWN', summary: `X复核失败:${e.message}`, mentions: 0 };
        }
    }
    
    /**
     * 计算综合评分 v2.0
     * 
     * 评分公式 (满分100):
     * - 聪明钱: 40% (smartWallet × 10, 封顶40)
     * - AI叙事: 25% (DeBot基础20 + LLM调节±5)
     * - TG共识: 15% (频道数 × 5, 封顶15)
     * - 报警动量: 10% (signalCount 黄金区间)
     * - 安全性: 10% (权限5 + 流动性5)
     */
    calculateScore(token, aiReport, tgHeat, llmResult = null) {
        const w = this.scoringConfig.weights;
        const momentum = this.scoringConfig.signalMomentum;
        let details = [];
        
        // 1. 聪明钱分数 (40%)
        const smartMoneyScore = Math.min((token.smartWalletOnline || 0) * 10, w.smartMoney);
        details.push(`聪明钱: ${smartMoneyScore}/${w.smartMoney}`);
        
        // 2. AI叙事分数 (25%) = DeBot基础(20) + LLM调节(±5)
        const debotScore = aiReport?.rating?.score || 0;
        const debotBase = Math.min(debotScore * 2, 20); // DeBot 1-10分 × 2 = 最高20分
        
        // LLM 调节分: (llmScore - 50) × 0.1，范围 [-5, +5]
        let llmAdjust = 0;
        if (llmResult && typeof llmResult.score === 'number') {
            llmAdjust = Math.max(-5, Math.min(5, (llmResult.score - 50) * 0.1));
        }
        const narrativeScore = Math.max(0, Math.min(debotBase + llmAdjust, w.narrative));
        details.push(`叙事: ${narrativeScore.toFixed(1)}/${w.narrative} (DeBot${debotBase}${llmAdjust >= 0 ? '+' : ''}${llmAdjust.toFixed(1)})`);
        
        // 3. TG共识分数 (15%)
        let tgScore = Math.min((tgHeat.channelCount || 0) * 5, w.telegram);
        // Tier 1 加成 (+2分，不超过上限)
        if (tgHeat.tier1Count > 0) {
            tgScore = Math.min(tgScore + 2, w.telegram);
        }
        details.push(`TG: ${tgScore}/${w.telegram}`);
        
        // 4. 报警动量分数 (10%) - 黄金区间规则
        const signalCount = token.signalCount || 0;
        let signalBonus = 0;
        let signalStatus = '';
        
        if (signalCount >= momentum.goldenMin && signalCount <= momentum.goldenMax) {
            signalBonus = 10;  // 🚀 黄金区 (最强)
            signalStatus = '🚀黄金区';
        } else if (signalCount > momentum.goldenMax && signalCount <= momentum.crowdedMax) {
            signalBonus = 5;   // 📈 鱼身区
            signalStatus = '📈鱼身区';
        } else if (signalCount > momentum.crowdedMax && signalCount <= momentum.overheat) {
            signalBonus = 0;   // ⚠️ 拥挤区
            signalStatus = '⚠️拥挤区';
        } else if (signalCount > momentum.overheat) {
            signalBonus = -5;  // 🔴 过热区 (扣分)
            signalStatus = '🔴过热区';
        } else {
            signalStatus = '冷启动';
        }
        details.push(`动量: ${signalBonus}/${w.signalMomentum} [${signalStatus}, ${signalCount}次]`);
        
        // 5. 安全性分数 (10%)
        let safetyScore = 0;
        if (token.isMintAbandoned !== false) {
            safetyScore += 5;
        }
        if ((token.liquidity || 0) >= this.hardGates.minLiquidity) {
            safetyScore += 5;
        }
        safetyScore = Math.min(safetyScore, w.safety);
        details.push(`安全: ${safetyScore}/${w.safety}`);
        
        // 总分
        const totalScore = smartMoneyScore + narrativeScore + tgScore + signalBonus + safetyScore;
        
        console.log(`📊 评分明细 [${Math.round(totalScore)}分]: ${details.join(' | ')}`);
        
        return {
            total: Math.round(totalScore),
            breakdown: {
                smartMoney: smartMoneyScore,
                narrative: narrativeScore,
                telegram: tgScore,
                signalMomentum: signalBonus,
                safety: safetyScore
            },
            signalCount: signalCount,
            llmRisk: llmResult?.risk_level || 'UNKNOWN',
            xRisk: 'SKIPPED',
            xSummary: null,
            xMentions: null
        };
    }
    
    /**
     * 做出决策 v2.0
     * 
     * 决策矩阵:
     * - < 50分: IGNORE
     * - 50-54分: WATCH
     * - 55-69分: BUY_SMALL (0.05 SOL)
     * - 70-79分: BUY_NORMAL (0.15 SOL)
     * - 80+分: BUY_MAX (0.20 SOL)
     * 
     * 强制降级规则:
     * - signalCount > 50: 强制 WATCH
     * - LLM risk_level = HIGH: 最高 WATCH
     */
    makeDecision(token, aiReport, tgHeat, score) {
        const thresholds = this.scoringConfig.thresholds;
        const positions = this.scoringConfig.positions;
        const momentum = this.scoringConfig.signalMomentum;
        
        // === 强制降级规则 ===
        
        // 规则1: 信号过热 (>50次) → 强制 WATCH
        if (score.signalCount > momentum.overheat) {
            return {
                action: 'WATCH',
                tier: null,
                reason: `🔴 信号过热 (${score.signalCount}次 > ${momentum.overheat})，强制观望`,
                position: 0
            };
        }
        
        // 规则2: LLM 识别高风险 → 强制 WATCH
        if (score.llmRisk === 'HIGH') {
            return {
                action: 'WATCH',
                tier: null,
                reason: `⚠️ AI识别高风险，强制观望`,
                position: 0
            };
        }

        // 规则3: X 边界复核高风险 → 强制 WATCH
        if (score.xRisk === 'HIGH') {
            return {
                action: 'WATCH',
                tier: null,
                reason: `⚠️ X边界复核高风险: ${score.xSummary || 'unknown'}`,
                position: 0
            };
        }
        
        // === 正常决策流程 ===
        
        // 低于忽略线 → IGNORE
        if (score.total < thresholds.ignore) {
            return {
                action: 'IGNORE',
                tier: null,
                reason: `❌ 评分不足 (${score.total}分 < ${thresholds.ignore})`,
                position: 0
            };
        }
        
        // 观察区间 [50, 55)
        if (score.total < thresholds.buySmall) {
            return {
                action: 'WATCH',
                tier: null,
                reason: `👀 观察中 (${score.total}分)`,
                position: 0
            };
        }
        
        // 买入区间
        let position, tier, emoji;
        
        if (score.total >= thresholds.buyMax) {
            // S级: 80+ 分
            position = positions.max;
            tier = 'MAX';
            emoji = '🚀';
        } else if (score.total >= thresholds.buyNormal) {
            // A级: 70-79 分
            position = positions.normal;
            tier = 'NORMAL';
            emoji = '✅';
        } else {
            // B级: 55-69 分 (潜伏局)
            position = positions.small;
            tier = 'SCOUT';
            emoji = '🐦';
        }
        
        return {
            action: 'BUY',
            tier,
            reason: `${emoji} ${tier}级 (${score.total}分) - ${this.getDecisionReason(token, aiReport, tgHeat, score)}`,
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
     * 打印验证结果 v2.0
     */
    printValidationResult(token, aiReport, tgHeat, score, decision, llmResult = null) {
        const symbol = token.symbol || token.tokenAddress.slice(0, 8);
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 [CrossValidator] 验证结果: ${symbol}`);
        console.log(`${'='.repeat(60)}`);
        
        // 基础信息
        console.log(`📍 地址: ${token.tokenAddress}`);
        console.log(`⛓️  链: ${token.chain}`);
        console.log(`💰 流动性: $${(token.liquidity || 0).toLocaleString()}`);
        console.log(`📢 报警次数: ${token.signalCount || 0}`);
        
        // 分数明细 (新版)
        console.log(`\n📈 评分明细 (总分: ${score.total}/100):`);
        console.log(`   聪明钱:   ${score.breakdown.smartMoney}/40 (${token.smartWalletOnline || 0}个在线)`);
        console.log(`   AI叙事:   ${score.breakdown.narrative.toFixed(1)}/25 (DeBot ${aiReport?.rating?.score || 0}/10${llmResult ? `, LLM ${llmResult.score}分` : ''})`);
        console.log(`   TG共识:   ${score.breakdown.telegram}/15 (${tgHeat.channelCount}个频道)`);
        console.log(`   报警动量: ${score.breakdown.signalMomentum}/10`);
        console.log(`   安全性:   ${score.breakdown.safety}/10`);
        
        // LLM 分析结果
        if (llmResult) {
            console.log(`\n🧠 LLM分析:`);
            console.log(`   评分: ${llmResult.score}/100`);
            console.log(`   判断: ${llmResult.reason}`);
            console.log(`   风险: ${llmResult.risk_level}`);
        }

        // X 边界复核
        if (score.xRisk && score.xRisk !== 'SKIPPED') {
            console.log(`\n🐦 X边界复核:`);
            console.log(`   风险: ${score.xRisk}`);
            if (score.xMentions !== null) console.log(`   提及: ${score.xMentions}`);
            if (score.xSummary) console.log(`   备注: ${score.xSummary}`);
        }
        
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
        
        console.log(`${'='.repeat(60)}\n`);
    }
    
    /**
     * 启动验证器 v2.0
     */
    start() {
        if (this.isRunning) {
            console.log('[CrossValidator] 已在运行中');
            return;
        }
        
        this.isRunning = true;
        this.init();
        
        const t = this.scoringConfig.thresholds;
        const m = this.scoringConfig.signalMomentum;
        
        console.log('\n🔄 [CrossValidator v2.0] 交叉验证引擎启动');
        console.log(`   Hard Gates:`);
        console.log(`     - 最少聪明钱: ${this.hardGates.minSmartWalletOnline}`);
        console.log(`     - 最低流动性: $${this.hardGates.minLiquidity}`);
        console.log(`     - 最低DeBot评分: ${this.hardGates.minAIScore}`);
        console.log(`   评分权重:`);
        console.log(`     - 聪明钱: 40% | AI叙事: 25% | TG共识: 15% | 动量: 10% | 安全: 10%`);
        console.log(`   决策阈值:`);
        console.log(`     - IGNORE: <${t.ignore}分 | WATCH: ${t.ignore}-${t.buySmall-1}分`);
        console.log(`     - BUY_SMALL: ${t.buySmall}-${t.buyNormal-1}分 | BUY_NORMAL: ${t.buyNormal}-${t.buyMax-1}分 | BUY_MAX: ${t.buyMax}+分`);
        console.log(`   报警动量黄金区间:`);
        console.log(`     - 黄金区: ${m.goldenMin}-${m.goldenMax}次 (+10分)`);
        console.log(`     - 过热强制WATCH: >${m.overheat}次`);
        console.log(`   LLM分析: ${process.env.AI_ANALYSIS_ENABLED === 'true' ? '✅ 已启用' : '❌ 未启用'}`);
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
