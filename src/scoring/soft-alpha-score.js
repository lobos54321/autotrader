/**
 * Soft Alpha Score Aggregator
 *
 * Combines all scoring modules and applies adjustments
 *
 * Total Formula:
 * Score = 0.25×Narrative + 0.25×Influence + 0.30×TG_Spread + 0.10×Graph + 0.10×Source
 *
 * Adjustments:
 * - Matrix Penalty (from TG_Spread, can be -20)
 * - X Validation (if x_authors < 2, multiply by 0.8)
 */

import TGSpreadScoring from './tg-spread.js';
import NarrativeDetector from './narrative-detector.js';
import { AINarrativeSystem } from './ai-narrative-system.js';
import { AIInfluencerSystem } from './ai-influencer-system.js';

export class SoftAlphaScorer {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.weights = config.soft_score_weights;

    // Initialize component scorers
    this.tgSpreadScorer = new TGSpreadScoring(config, db);
    this.narrativeDetector = new NarrativeDetector();
    
    // Initialize AI-powered systems
    this.aiNarrativeSystem = new AINarrativeSystem(config, db);
    this.aiInfluencerSystem = new AIInfluencerSystem(config, db);
    
    // Flags to use AI systems (can be toggled)
    this.useAINarrative = true;
    this.useAIInfluencer = true;
  }

  /**
   * Main entry: Calculate complete Soft Alpha Score
   *
   * @param {Object} socialData - social_snapshots data
   * @param {Object} tokenData - token basic info
   * @returns {Object} { score, breakdown, reasons }
   */
  async calculate(socialData, tokenData) {
    console.log(`🎯 [Soft Score] Calculating for ${tokenData.token_ca}`);

    // Component scores - use AI narrative if enabled
    let narrative;
    if (this.useAINarrative) {
      // Prepare twitter data for AI narrative
      const twitterData = {
        mention_count: socialData.twitter_mentions || 0,
        sentiment: socialData.twitter_sentiment || 'neutral',
        unique_authors: socialData.twitter_unique_authors || 0
      };
      
      narrative = await this.aiNarrativeSystem.scoreNarrative(
        tokenData.symbol,
        tokenData.name,
        twitterData
      );
      
      // Log AI narrative detection
      if (narrative.narrative) {
        console.log(`   📖 AI Narrative: ${narrative.narrative} (weight: ${narrative.breakdown?.narrative_weight?.toFixed(1) || 'N/A'}/10, stage: ${narrative.breakdown?.lifecycle_stage || 'unknown'})`);
      }
    } else {
      narrative = this.calculateNarrative(socialData, tokenData);
    }
    
    // Use AI Influencer System if enabled
    let influence;
    if (this.useAIInfluencer) {
      // Prepare twitter data for influence detection
      const twitterData = {
        mention_count: socialData.twitter_mentions || 0,
        unique_authors: socialData.twitter_unique_authors || 0,
        top_tweets: socialData.top_tweets || []
      };
      
      // Get channel name from socialData
      const channelName = socialData.channels?.[0] || socialData.channel_name || '';
      
      influence = this.aiInfluencerSystem.calculateInfluenceScore(channelName, twitterData);
      
      // Log AI influence detection
      console.log(`   👥 AI Influence: Channel ${influence.breakdown.channel_tier} (${influence.breakdown.channel_score}pts), KOLs: ${influence.breakdown.kol_mentions.length} (${influence.breakdown.kol_score}pts)`);
    } else {
      influence = this.calculateInfluence(socialData);
    }
    
    const tgSpread = this.tgSpreadScorer.calculate(socialData, tokenData.token_ca);
    const graph = this.calculateGraph(socialData);
    const source = this.calculateSource(socialData);

    // 直接相加（每个维度的满分已经代表了权重）
    // Narrative: 0-25, Influence: 0-25, TG_Spread: 0-30, Graph: 0-10, Source: 0-10
    // 总分满分 = 25 + 25 + 30 + 10 + 10 = 100
    const rawScore =
      narrative.score +
      influence.score +
      tgSpread.score +
      graph.score +
      source.score;

    // Matrix Penalty (already in TG_Spread score, but track separately)
    const matrixPenalty = tgSpread.breakdown.matrix_penalty.penalty;

    // X Validation adjustment
    const xMultiplier = this.calculateXValidationMultiplier(socialData);

    // Final score
    const finalScore = Math.max(0, Math.min(100, rawScore * xMultiplier));

    return {
      score: Math.round(finalScore),
      breakdown: {
        narrative,
        influence,
        tg_spread: tgSpread,
        graph,
        source
      },
      adjustments: {
        matrix_penalty: matrixPenalty,
        x_multiplier: xMultiplier
      },
      reasons: this.aggregateReasons([narrative, influence, tgSpread, graph, source])
    };
  }

  /**
   * Narrative Scoring (0-25 points)
   *
   * Data-driven narrative detection using NarrativeDetector module
   * Weights derived from real market data (CoinGecko, DeFi Llama, Messari)
   *
   * Components:
   * - Base narrative weight (0-10 scale from research)
   * - Confidence multiplier (based on keyword match density)
   * - Twitter validation bonus (+20% if Twitter confirms narrative)
   *
   * Final score: 0-25 points
   */
  calculateNarrative(socialData, tokenData) {
    // Extract Twitter data for validation
    const twitterData = {
      mention_count: socialData.twitter_mentions || 0,
      unique_authors: socialData.twitter_unique_authors || 0,
      kol_count: socialData.twitter_kol_count || 0,
      engagement: socialData.twitter_engagement || 0,
      sentiment: socialData.twitter_sentiment || 'neutral',
      top_tweets: [] // Not available from socialData, but detector handles this
    };

    // Use NarrativeDetector to detect narratives
    const detection = this.narrativeDetector.detect(tokenData, twitterData);

    const reasons = [];

    if (detection.topNarrative) {
      const narrative = detection.topNarrative;

      // Log detection details
      console.log(`   📖 Narrative: ${narrative.name} (weight: ${narrative.weight}/10, confidence: ${(narrative.confidence * 100).toFixed(0)}%)`);

      reasons.push(`Narrative: ${narrative.name.replace(/_/g, ' ')} (weight: ${narrative.weight}/10)`);

      if (narrative.confidence >= 0.8) {
        reasons.push(`High confidence match (${(narrative.confidence * 100).toFixed(0)}%)`);
      }

      if (narrative.matchedKeywords.length > 0) {
        reasons.push(`Keywords: ${narrative.matchedKeywords.slice(0, 3).join(', ')}`);
      }

      if (detection.breakdown.twitter_validated) {
        reasons.push('✨ Twitter validates narrative (+20% bonus)');
      }
    } else {
      reasons.push('No narrative detected');
    }

    return {
      score: detection.score,
      reasons,
      narrative_name: detection.topNarrative ? detection.topNarrative.name : null,
      all_narratives: detection.narratives
    };
  }

  /**
   * Influence Scoring (0-25 points)
   *
   * - TG channel quality (0-15): Based on Tier distribution
   * - X KOL participation (0-10): Based on Twitter KOL count
   * - Unknown channel base score: 3 points (not penalized for new sources)
   */
  calculateInfluence(socialData) {
    let score = 0;
    const reasons = [];

    // Parse promoted channels
    const channels = typeof socialData.promoted_channels === 'string' ?
      JSON.parse(socialData.promoted_channels) : socialData.promoted_channels || [];

    // TG channel quality (0-15)
    if (channels.length > 0) {
      const tierACounts = channels.filter(ch => ch.tier === 'A').length;
      const tierBCounts = channels.filter(ch => ch.tier === 'B').length;
      const tierCCounts = channels.filter(ch => ch.tier === 'C').length;
      const blacklistCounts = channels.filter(ch => ch.tier === 'BLACKLIST').length;

      if (blacklistCounts > 0) {
        score = 0;
        reasons.push(`⚠️ Blacklisted channels detected: ${blacklistCounts}`);
        return { score, reasons };
      }

      // Calculate channel score
      // Tier A = 3 points, Tier B = 1.5 points, Tier C (unknown) = 0.5 points (base)
      const channelScore = tierACounts * 3 + tierBCounts * 1.5 + tierCCounts * 0.5;
      score += Math.min(15, channelScore);

      if (tierACounts >= 2) {
        reasons.push(`Strong channel support: ${tierACounts} Tier A channels`);
      } else if (tierACounts >= 1) {
        reasons.push(`Decent channel support: ${tierACounts} Tier A, ${tierBCounts} Tier B`);
      } else if (tierBCounts >= 1) {
        reasons.push(`Moderate channel support: ${tierBCounts} Tier B channels`);
      } else {
        // Unknown channel - give base score instead of 0
        score = Math.max(score, 3);
        reasons.push(`Unknown channel source (base score applied)`);
      }
    } else {
      // No channel info at all - give minimal base score
      score = 2;
      reasons.push('No channel information available');
    }

    // X KOL participation (0-10)
    // Now based on twitter_kol_count from Grok API
    const kolCount = socialData.twitter_kol_count || 0;
    if (kolCount >= 3) {
      score += 10;
      reasons.push(`Strong KOL support: ${kolCount} KOLs mentioned`);
    } else if (kolCount >= 1) {
      score += 5;
      reasons.push(`KOL support: ${kolCount} KOL(s) mentioned`);
    } else if (socialData.x_tier1_hit) {
      score += 10;
      reasons.push('Tier 1 KOL endorsement detected');
    }

    return {
      score: Math.min(25, score),
      reasons: reasons.length > 0 ? reasons : ['No influence indicators']
    };
  }

  /**
   * Graph Scoring (0-10 points) - 链上数据评分
   *
   * 评估：
   * - 流动性深度（是否足够交易）
   * - Top10 持仓集中度（是否有 rug 风险）
   * - 持仓人数（是否有足够的市场参与）
   * - TG/Twitter 同步增长（热度验证）
   */
  calculateGraph(socialData) {
    let score = 0;
    const reasons = [];
    const chainData = socialData.chain_data || {};

    // ==========================================
    // 1. 流动性评分 (0-4 分)
    // ==========================================
    const liquidityUSD = chainData.liquidity_usd || 0;
    const isPumpfun = chainData.is_pumpfun || false;
    const marketCap = chainData.market_cap || 0;
    const volume24h = chainData.volume_24h || 0;
    const txns24h = chainData.txns_24h || 0;
    const bondingProgress = chainData.bonding_progress || 0;

    // ==========================================
    // Pump.fun 特殊评分逻辑
    // ==========================================
    if (isPumpfun) {
      // Pump.fun 用 marketCap + volume + txns 评分
      
      // 市值评分 (0-3分)
      if (marketCap >= 50000) {
        score += 3;
        reasons.push(`🚀 高市值: $${(marketCap/1000).toFixed(0)}K`);
      } else if (marketCap >= 20000) {
        score += 2;
        reasons.push(`📈 中市值: $${(marketCap/1000).toFixed(0)}K`);
      } else if (marketCap >= 5000) {
        score += 1;
        reasons.push(`市值: $${(marketCap/1000).toFixed(1)}K`);
      } else {
        reasons.push(`低市值: $${marketCap.toFixed(0)}`);
      }

      // 24h 交易量评分 (0-2分)
      if (volume24h >= 50000) {
        score += 2;
        reasons.push(`🔥 高交易量: $${(volume24h/1000).toFixed(0)}K`);
      } else if (volume24h >= 10000) {
        score += 1;
        reasons.push(`交易量: $${(volume24h/1000).toFixed(0)}K`);
      }

      // 24h 交易次数评分 (0-2分)
      if (txns24h >= 500) {
        score += 2;
        reasons.push(`🔥 活跃交易: ${txns24h}笔`);
      } else if (txns24h >= 100) {
        score += 1;
        reasons.push(`交易: ${txns24h}笔`);
      }

      // Bonding 进度 (0-2分) - 接近毕业加分
      if (bondingProgress >= 80) {
        score += 2;
        reasons.push(`🎓 即将毕业: ${bondingProgress.toFixed(0)}%`);
      } else if (bondingProgress >= 50) {
        score += 1;
        reasons.push(`进度: ${bondingProgress.toFixed(0)}%`);
      }

      // TG+Twitter 同步 (0-1分)
      if (socialData.x_unique_authors_15m && socialData.x_unique_authors_15m >= 3) {
        score += 1;
        reasons.push('TG+Twitter 同步');
      }

      return {
        score: Math.min(10, score),
        reasons
      };
    }

    // ==========================================
    // 非 Pump.fun：正常流动性评分
    // ==========================================
    if (liquidityUSD >= 100000) {
      score += 4;
      reasons.push(`优秀流动性: $${(liquidityUSD/1000).toFixed(0)}K`);
    } else if (liquidityUSD >= 50000) {
      score += 3;
      reasons.push(`良好流动性: $${(liquidityUSD/1000).toFixed(0)}K`);
    } else if (liquidityUSD >= 20000) {
      score += 2;
      reasons.push(`一般流动性: $${(liquidityUSD/1000).toFixed(0)}K`);
    } else if (liquidityUSD >= 10000) {
      score += 1;
      reasons.push(`低流动性: $${(liquidityUSD/1000).toFixed(0)}K`);
    } else if (liquidityUSD > 0) {
      score += 0;
      reasons.push(`⚠️ 极低流动性: $${liquidityUSD.toFixed(0)}`);
    } else {
      // 无数据，给默认分
      score += 2;
      reasons.push('流动性未知');
    }

    // ==========================================
    // 2. Top10 持仓集中度 (0-3 分)
    // ==========================================
    const top10Percent = chainData.top10_percent;
    
    if (top10Percent !== null && top10Percent !== undefined) {
      if (top10Percent <= 30) {
        score += 3;
        reasons.push(`分散持仓: Top10=${top10Percent.toFixed(1)}%`);
      } else if (top10Percent <= 50) {
        score += 2;
        reasons.push(`中度集中: Top10=${top10Percent.toFixed(1)}%`);
      } else if (top10Percent <= 70) {
        score += 1;
        reasons.push(`较集中: Top10=${top10Percent.toFixed(1)}%`);
      } else {
        score += 0;
        reasons.push(`⚠️ 高度集中: Top10=${top10Percent.toFixed(1)}%`);
      }
    } else {
      // 无数据，给默认分
      score += 1;
      reasons.push('持仓数据未知');
    }

    // ==========================================
    // 3. 持仓人数 (0-2 分)
    // ==========================================
    const holderCount = chainData.holder_count;
    
    if (holderCount !== null && holderCount !== undefined) {
      if (holderCount >= 500) {
        score += 2;
        reasons.push(`多持仓人: ${holderCount}人`);
      } else if (holderCount >= 100) {
        score += 1;
        reasons.push(`中等持仓人: ${holderCount}人`);
      } else {
        score += 0;
        reasons.push(`少持仓人: ${holderCount}人`);
      }
    } else {
      score += 1;
      reasons.push('持仓人数未知');
    }

    // ==========================================
    // 4. TG/Twitter 同步验证 (0-1 分)
    // ==========================================
    if (socialData.x_unique_authors_15m && socialData.x_unique_authors_15m >= 3) {
      score += 1;
      reasons.push('TG+Twitter 同步增长');
    }

    return {
      score: Math.min(10, score),
      reasons
    };
  }

  /**
   * Source Scoring (0-10 points) - 信号源质量评分
   *
   * 评估：
   * - 信号时效性（距离第一次提及多久）
   * - 频道历史表现（胜率、平均收益）- 从数据库查询
   */
  calculateSource(socialData) {
    let score = 0;
    const reasons = [];

    // ==========================================
    // 1. 信号时效性 (0-5 分)
    // ==========================================
    const timeLag = socialData.tg_time_lag || 0;

    if (timeLag <= 2) {
      score += 5;
      reasons.push(`极早信号: ${timeLag}分钟`);
    } else if (timeLag <= 5) {
      score += 4;
      reasons.push(`早期信号: ${timeLag}分钟`);
    } else if (timeLag <= 10) {
      score += 3;
      reasons.push(`及时信号: ${timeLag}分钟`);
    } else if (timeLag <= 15) {
      score += 2;
      reasons.push(`一般时效: ${timeLag}分钟`);
    } else if (timeLag <= 30) {
      score += 1;
      reasons.push(`较晚信号: ${timeLag}分钟`);
    } else {
      score += 0;
      reasons.push(`⚠️ 过时信号: ${timeLag}分钟`);
    }

    // ==========================================
    // 2. 频道历史表现 (0-5 分) - 从数据库查询
    // ==========================================
    const channelName = socialData.channel_name;
    let channelPerformance = null;

    try {
      if (this.db && channelName) {
        // 查询这个频道过去 7 天的表现
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
        
        const stats = this.db.prepare(`
          SELECT 
            COUNT(*) as total_trades,
            SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as winning_trades,
            AVG(pnl_percent) as avg_pnl,
            MAX(pnl_percent) as best_trade,
            MIN(pnl_percent) as worst_trade
          FROM positions p
          JOIN telegram_signals s ON p.signal_id = s.id
          WHERE s.channel_name = ? 
            AND p.status = 'closed'
            AND p.created_at >= ?
        `).get(channelName, sevenDaysAgo);

        if (stats && stats.total_trades >= 3) {
          channelPerformance = {
            total: stats.total_trades,
            winRate: (stats.winning_trades / stats.total_trades) * 100,
            avgPnl: stats.avg_pnl || 0,
            bestTrade: stats.best_trade || 0,
            worstTrade: stats.worst_trade || 0
          };
        }
      }
    } catch (e) {
      // 数据库查询失败，忽略
    }

    if (channelPerformance) {
      const winRate = channelPerformance.winRate;
      const avgPnl = channelPerformance.avgPnl;

      // 基于胜率评分
      if (winRate >= 60) {
        score += 3;
        reasons.push(`高胜率频道: ${winRate.toFixed(0)}%`);
      } else if (winRate >= 45) {
        score += 2;
        reasons.push(`中等胜率: ${winRate.toFixed(0)}%`);
      } else if (winRate >= 30) {
        score += 1;
        reasons.push(`较低胜率: ${winRate.toFixed(0)}%`);
      } else {
        score += 0;
        reasons.push(`⚠️ 低胜率: ${winRate.toFixed(0)}%`);
      }

      // 基于平均收益评分
      if (avgPnl >= 50) {
        score += 2;
        reasons.push(`高平均收益: +${avgPnl.toFixed(0)}%`);
      } else if (avgPnl >= 20) {
        score += 1;
        reasons.push(`正向收益: +${avgPnl.toFixed(0)}%`);
      } else if (avgPnl >= 0) {
        score += 0;
        reasons.push(`微利: ${avgPnl.toFixed(0)}%`);
      } else {
        score -= 1; // 负收益扣分
        reasons.push(`⚠️ 负收益: ${avgPnl.toFixed(0)}%`);
      }
    } else {
      // 没有历史数据，给中等分数
      score += 2;
      reasons.push('新频道(无历史数据)');
    }

    return {
      score: Math.max(0, Math.min(10, score)),
      reasons
    };
  }

  /**
   * X Validation Multiplier
   *
   * If X data is weak (< 2 unique authors in 15min) and mostly Tier C channels,
   * multiply final score by 0.8
   */
  calculateXValidationMultiplier(socialData) {
    const xAuthors = socialData.x_unique_authors_15m;
    const minAuthors = this.config.soft_score_thresholds.x_validation.min_unique_authors;

    // Parse channels
    const channels = typeof socialData.promoted_channels === 'string' ?
      JSON.parse(socialData.promoted_channels) : socialData.promoted_channels || [];

    const tierCCounts = channels.filter(ch => ch.tier === 'C').length;
    const tierCRatio = channels.length > 0 ? tierCCounts / channels.length : 0;

    // Apply penalty if X is weak AND mostly Tier C
    if ((xAuthors === null || xAuthors < minAuthors) && tierCRatio > 0.7) {
      return this.config.soft_score_thresholds.x_validation.score_multiplier_if_low;
    }

    return 1.0;
  }

  /**
   * Aggregate reasons from all components
   */
  aggregateReasons(components) {
    const allReasons = [];

    for (const component of components) {
      if (component.reasons && component.reasons.length > 0) {
        allReasons.push(...component.reasons);
      }
    }

    return allReasons;
  }

  /**
   * Persist score details to database
   */
  async persistScoreDetails(tokenCA, scoreResult) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO score_details (
          token_ca,
          calculated_at,
          narrative_score,
          narrative_reasons,
          influence_score,
          influence_reasons,
          tg_spread_score,
          tg_spread_reasons,
          graph_score,
          graph_reasons,
          source_score,
          source_reasons,
          matrix_penalty,
          x_validation_multiplier,
          total_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        tokenCA,
        Date.now(),
        scoreResult.breakdown.narrative.score,
        JSON.stringify(scoreResult.breakdown.narrative.reasons),
        scoreResult.breakdown.influence.score,
        JSON.stringify(scoreResult.breakdown.influence.reasons),
        scoreResult.breakdown.tg_spread.score,
        JSON.stringify(scoreResult.breakdown.tg_spread.reasons),
        scoreResult.breakdown.graph.score,
        JSON.stringify(scoreResult.breakdown.graph.reasons),
        scoreResult.breakdown.source.score,
        JSON.stringify(scoreResult.breakdown.source.reasons),
        scoreResult.adjustments.matrix_penalty,
        scoreResult.adjustments.x_multiplier,
        scoreResult.score
      );

      console.log('✅ [Soft Score] Score details persisted');
    } catch (error) {
      console.error('❌ [Soft Score] Failed to persist:', error.message);
    }
  }
}

export default SoftAlphaScorer;
