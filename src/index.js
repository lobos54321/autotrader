/**
 * Sentiment Arbitrage System - Main Entry Point
 * MVP 2.0 - Production-Ready On-Chain Sentiment Arbitrage
 *
 * Architecture:
 * 1. Telegram Signal Listener → Captures market signals
 * 2. Chain Snapshot → Real-time on-chain data (SOL/BSC)
 * 3. Hard Gates → Binary quality filters (liquidity, security, slippage)
 * 4. Soft Alpha Score → Multi-factor scoring (TG spread, holder quality, momentum)
 * 5. Decision Matrix → Buy/Greylist/Reject based on scores
 * 6. Position Sizer → Kelly-optimized position sizing
 * 7. GMGN Executor → Telegram Bot-based execution
 * 8. Position Monitor → Three-tier exit strategy
 * 9. Signal Source Optimizer → Auto-optimize signal sources for higher win rate
 */

import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { TelegramUserListener } from './inputs/telegram-user-listener.js';
import { SolanaSnapshotService } from './inputs/chain-snapshot-sol.js';
import { BSCSnapshotService } from './inputs/chain-snapshot-bsc.js';
import { HardGateFilter } from './gates/hard-gates.js';
import { ExitGateFilter } from './gates/exit-gates.js';
import { SoftAlphaScorer } from './scoring/soft-alpha-score.js';
import { DecisionMatrix } from './decision/decision-matrix.js';
import { PositionSizer } from './decision/position-sizer.js';
import { GMGNTelegramExecutor } from './execution/gmgn-telegram-executor.js';
import { PositionMonitorV2 } from './execution/position-monitor-v2.js';
import GrokTwitterClient from './social/grok-twitter-client.js';
import { PermanentBlacklistService } from './database/permanent-blacklist.js';
import { SignalSourceOptimizer } from './scoring/signal-source-optimizer.js';
import { ShadowPriceTracker } from './tracking/shadow-price-tracker.js';
import { startDashboardServer } from './web/dashboard-server.js';
import { RiskManager } from './risk/risk-manager.js';
import { SmartMoneyTracker } from './tracking/smart-money-tracker.js';
import { SmartMoneyScout } from './execution/smart-money-scout.js';
import { GMGNSmartMoneyScout } from './inputs/gmgn-smart-money.js';

dotenv.config();

class SentimentArbitrageSystem {
  constructor() {
    this.config = this.loadConfig();
    this.db = new Database(this.config.DB_PATH);

    // Initialize services
    this.telegramService = new TelegramUserListener(this.config, this.db);
    this.solService = new SolanaSnapshotService(this.config);
    this.bscService = new BSCSnapshotService(this.config);
    this.hardGateService = new HardGateFilter(this.config);
    this.exitGateService = new ExitGateFilter(this.config);
    this.softScorer = new SoftAlphaScorer(this.config, this.db);
    this.decisionEngine = new DecisionMatrix(this.config, this.db);
    this.positionSizer = new PositionSizer(this.config, this.db);
    this.executor = new GMGNTelegramExecutor(this.config, this.db);
    this.positionMonitor = new PositionMonitorV2(this.config, this.db);
    this.grokClient = new GrokTwitterClient();
    this.blacklistService = new PermanentBlacklistService(this.db);
    
    // Risk Manager - 风险管理系统
    this.riskManager = new RiskManager(this.config, this.db);
    
    // Signal Source Optimizer - auto-optimize for higher win rate
    this.sourceOptimizer = new SignalSourceOptimizer(this.config, this.db);
    
    // Smart Money Tracker - 聪明钱追踪
    this.smartMoneyTracker = new SmartMoneyTracker(this.config, this.softScorer.dynamicScoring);
    
    // Smart Money Scout - 引擎 A（独立聪明钱触发）
    this.smartMoneyScout = new SmartMoneyScout(
      this.config,
      { SOL: this.solService, BSC: this.bscService },
      this.executor,
      this.db
    );
    
    // GMGN Smart Money Scout - 替代 DeBot（无需 Cookie）
    this.gmgnScout = new GMGNSmartMoneyScout({
      chains: ['sol', 'bsc'],
      pollInterval: 60000,  // 1分钟轮询
      minSmartBuyers: 2     // 最少2个聪明钱买家触发
    });
    
    // Shadow Price Tracker - track prices in shadow mode for source evaluation
    this.shadowTracker = new ShadowPriceTracker(
      this.config, 
      this.db, 
      this.solService, 
      this.bscService,
      this.sourceOptimizer
    );

    // System state
    this.isRunning = false;
    this.processedSignals = new Map();
    this.stats = {
      signals_received: 0,
      hard_gate_passed: 0,
      soft_score_computed: 0,
      buy_decisions: 0,
      greylist_decisions: 0,
      reject_decisions: 0,
      executions_success: 0,
      executions_failed: 0
    };

    console.log('\n' + '═'.repeat(80));
    console.log('🤖 SENTIMENT ARBITRAGE SYSTEM v2.0');
    console.log('═'.repeat(80));
    console.log(`Mode: ${this.config.SHADOW_MODE ? '🎭 SHADOW' : '💰 LIVE'}`);
    console.log(`Auto Buy: ${this.config.AUTO_BUY_ENABLED ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`Database: ${this.config.DB_PATH}`);
    console.log('═'.repeat(80) + '\n');
  }

  /**
   * Load configuration from environment
   */
  loadConfig() {
    return {
      // Database
      DB_PATH: process.env.DB_PATH || './data/sentiment_arb.db',

      // System mode
      NODE_ENV: process.env.NODE_ENV || 'development',
      SHADOW_MODE: process.env.SHADOW_MODE === 'true',
      AUTO_BUY_ENABLED: process.env.AUTO_BUY_ENABLED === 'true',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',

      // Safety limits
      MAX_CONCURRENT_POSITIONS: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '10'),
      MAX_DAILY_TRADES: parseInt(process.env.MAX_DAILY_TRADES || '50'),
      TOTAL_CAPITAL_SOL: parseFloat(process.env.TOTAL_CAPITAL_SOL || '10.0'),
      TOTAL_CAPITAL_BNB: parseFloat(process.env.TOTAL_CAPITAL_BNB || '1.0'),

      // Position monitor
      POSITION_MONITOR_INTERVAL_MS: 120000, // 2 minutes

      // Signal processing
      SIGNAL_POLL_INTERVAL_MS: 30000, // 30 seconds
      MIN_SIGNAL_INTERVAL_MS: 60000, // Don't reprocess same token within 1 minute

      // Soft score weights (total = 1.0)
      soft_score_weights: {
        Narrative: 0.25,
        Influence: 0.25,
        TG_Spread: 0.30,
        Graph: 0.10,
        Source: 0.10
      },

      // Soft score thresholds
      soft_score_thresholds: {
        tg_spread: {
          excellent_channels: 8,
          good_channels: 5,
          min_channels: 3,
          max_cluster_penalty: 20,
          ch_15m_high: 8,
          min_clusters: 3,
          matrix_penalty_threshold: 2
        },
        holder_quality: {
          max_top10_concentration: 30,
          min_unique_holders: 100,
          risk_wallet_threshold: 50
        },
        momentum: {
          price_change_24h_min: 10,
          volume_increase_min: 2.0
        },
        security: {
          min_security_score: 60
        },
        x_validation: {
          min_unique_authors: 2,
          multiplier_below_threshold: 0.8,
          score_multiplier_if_low: 0.8
        },
        source: {
          time_lag_excellent_min: 5,
          time_lag_good_min: 15,
          time_lag_poor_min: 30
        }
      },

      // Hard gate thresholds
      hard_gate_thresholds: {
        SOL: {
          min_liquidity_usd: 10000,
          min_holders: 50,
          max_top10_percent: 50,
          max_slippage_bps: 200,
          max_tax_percent: 5,
          lp_lock_min_days: 30
        },
        BSC: {
          min_liquidity_usd: 20000,
          min_holders: 100,
          max_top10_percent: 60,
          max_slippage_bps: 300,
          max_tax_percent: 5,
          lp_lock_min_days: 30,
          owner_safe_types: ['Renounced', 'MultiSig', 'TimeLock', 'Burned']
        }
      },

      // Exit gate thresholds
      exit_gate_thresholds: {
        SOL: {
          min_liquidity_sol: 50,
          max_top10_percent: 30,
          max_wash_with_risk: 'MEDIUM'
        },
        BSC: {
          min_liquidity_bnb: 100,
          min_volume_24h_usd: 500000,
          max_top10_percent: 40
        }
      },

      // Exit gate slippage config
      exit_gate_slippage: {
        test_sell_percentage: 20,
        sol_pass_threshold_pct: 2,
        sol_reject_threshold_pct: 5,
        bsc_pass_threshold_pct: 3,
        bsc_reject_threshold_pct: 8
      },

      // Decision matrix configuration
      decision_matrix: {
        rules: [
          { score_min: 80, score_max: 100, rating: 'S', action: 'AUTO_BUY', position_tier: 'large' },
          { score_min: 65, score_max: 79, rating: 'A', action: 'AUTO_BUY', position_tier: 'medium' },
          { score_min: 50, score_max: 64, rating: 'B', action: 'AUTO_BUY', position_tier: 'small' },
          { score_min: 35, score_max: 49, rating: 'C', action: 'WATCH_ONLY', position_tier: null },
          { score_min: 0, score_max: 34, rating: 'F', action: 'REJECT', position_tier: null }
        ]
      },

      // Position size templates
      position_templates: {
        SOL: {
          large: { sol: 2.0, usd_approx: 200 },
          medium: { sol: 1.0, usd_approx: 100 },
          small: { sol: 0.5, usd_approx: 50 }
        },
        BSC: {
          large: { bnb: 0.5, usd_approx: 200 },
          medium: { bnb: 0.25, usd_approx: 100 },
          small: { bnb: 0.125, usd_approx: 50 }
        }
      },

      // Cooldown periods
      cooldowns: {
        same_token_minutes: 60,
        same_token_min: 60,  // Alias for position-sizer.js compatibility
        same_narrative_minutes: 30,
        same_narrative_max_concurrent: 3,
        failed_trade_minutes: 15
      },

      // Position limits
      position_limits: {
        max_concurrent: 10,
        max_concurrent_positions: 10,  // Alias for position-sizer.js compatibility
        max_daily_trades: 50,
        max_per_narrative: 3
      },

      // Capital allocation
      total_capital_sol: process.env.TOTAL_CAPITAL_SOL || '10.0',
      total_capital_bnb: process.env.TOTAL_CAPITAL_BNB || '1.0'
    };
  }

  /**
   * Start the system
   */
  async start() {
    try {
      console.log('▶️  Starting Sentiment Arbitrage System...\n');

      // 0. Start Dashboard server
      console.log('🌐 Starting Dashboard server...');
      startDashboardServer();
      console.log('   ✅ Dashboard server active\n');

      // 1. Start Telegram listener
      console.log('📱 Starting Telegram signal listener...');
      await this.telegramService.start();
      console.log('   ✅ Telegram listener active\n');

      // 2. Start position monitor
      console.log('📊 Starting position monitor...');
      await this.positionMonitor.start();
      console.log('   ✅ Position monitor active\n');

      // 2.5 Start GMGN Multi-Signal Scout (替代 DeBot - 无需 Cookie)
      console.log('🌐 Starting GMGN Multi-Signal Scout...');
      await this.gmgnScout.start();
      // 监听 GMGN 多维信号
      this.gmgnScout.on('signal', (signal) => {
        const info = signal.signal_type === 'smart_money' ? `${signal.smart_money_count} 个聪明钱` :
                     signal.signal_type === 'kol' ? `${signal.kol_count} 个KOL持仓` :
                     signal.signal_type === 'surge' ? `5m涨幅 ${signal.price_change_5m}%` :
                     signal.signal_type === 'dex_paid' ? 'DEX付费推广' :
                     signal.signal_type === 'ai_signal' ? 'AI推荐' : '';
        console.log(`\n${signal.emoji} [GMGN ${signal.signal_type.toUpperCase()}] ${signal.symbol} (${signal.chain}) - ${info}`);
        // 将信号写入数据库，由主循环处理
        this.injectSignal(signal);
      });
      console.log('   ✅ GMGN Multi-Signal Scout active');
      console.log('      - 🐋 Smart Money (聪明钱)');
      console.log('      - 👑 KOL Signals (KOL信号)');
      console.log('      - 🚀 Surge Alert (飙升榜)');
      console.log('      - 💎 DEX Paid (付费推广)');
      console.log('      - 🤖 AI Signals (AI信号)\n');

      // 2.6 Start Scout Engine (引擎 A - 聪明钱触发) - 可选
      if (process.env.SCOUT_ENABLED === 'true') {
        console.log('🔭 Starting Legacy Smart Money Scout...');
        await this.smartMoneyScout.start();
        console.log('   ✅ Legacy Scout engine active\n');
      }

      // 3. Start signal processing loop
      this.isRunning = true;
      this.startSignalProcessingLoop();

      console.log('✅ System fully operational!\n');
      console.log('━'.repeat(80));
      console.log('Waiting for signals...\n');

    } catch (error) {
      console.error('❌ System startup failed:', error);
      throw error;
    }
  }

  /**
   * Signal processing loop
   */
  startSignalProcessingLoop() {
    this.signalInterval = setInterval(async () => {
      try {
        await this.processNewSignals();
      } catch (error) {
        console.error('❌ Signal processing error:', error.message);
      }
    }, this.config.SIGNAL_POLL_INTERVAL_MS);
  }

  /**
   * Process new signals from Telegram
   */
  async processNewSignals() {
    try {
      // Get unprocessed signals
      const signals = this.db.prepare(`
        SELECT * FROM telegram_signals
        WHERE processed = 0
        ORDER BY timestamp ASC
        LIMIT 10
      `).all();

      for (const signal of signals) {
        await this.processSignal(signal);
      }

    } catch (error) {
      console.error('❌ Process new signals error:', error.message);
    }
  }

  /**
   * Process individual signal through complete pipeline
   */
  async processSignal(signal) {
    const { id, token_ca, chain, channel_name } = signal;
    const symbol = token_ca.substring(0, 8);

    try {
      // Check if recently processed
      const cacheKey = `${chain}:${token_ca}`;
      if (this.processedSignals.has(cacheKey)) {
        const lastProcessed = this.processedSignals.get(cacheKey);
        if (Date.now() - lastProcessed < this.config.MIN_SIGNAL_INTERVAL_MS) {
          this.markSignalProcessed(id);
          return;
        }
      }

      // ==========================================
      // STEP -1: CHECK SIGNAL SOURCE QUALITY
      // ==========================================
      const shouldUse = this.sourceOptimizer.shouldUseSource('telegram', channel_name);
      if (!shouldUse) {
        // Source is blacklisted or inactive - skip silently
        this.markSignalProcessed(id);
        return;
      }

      console.log('\n' + '─'.repeat(80));
      console.log(`🔔 NEW SIGNAL: ${symbol} (${chain}) from ${channel_name}`);
      console.log('─'.repeat(80));

      this.stats.signals_received++;
      
      // ==========================================
      // STEP 0.5: RISK MANAGER - CAN WE TRADE?
      // ==========================================
      const canTradeCheck = this.riskManager.canTrade();
      if (!canTradeCheck.allowed) {
        console.log(`\n🛡️ [Risk] 无法交易: ${canTradeCheck.reason}`);
        this.markSignalProcessed(id);
        return;
      }

      // Record signal for source tracking
      const signalOutcomeId = this.sourceOptimizer.recordSignal(
        'telegram', 
        channel_name, 
        channel_name, 
        token_ca, 
        chain
      );
      
      // Store for shadow tracking later
      this.lastSignalOutcomeId = signalOutcomeId;

      // ==========================================
      // STEP 0: PERMANENT BLACKLIST CHECK
      // ==========================================
      const blacklistRecord = this.blacklistService.isBlacklisted(token_ca, chain);
      if (blacklistRecord) {
        console.log(`\n🚫 [0/7] PERMANENT BLACKLIST HIT`);
        console.log(`   Token: ${chain}/${token_ca}`);
        console.log(`   Reason: ${blacklistRecord.blacklist_reason}`);
        console.log(`   Blacklisted: ${new Date(blacklistRecord.blacklist_timestamp).toISOString()}`);
        console.log(`   ❌ REJECTED - Permanent blacklist (不再处理)`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      // ==========================================
      // STEP 1: CHAIN SNAPSHOT + TOKEN METADATA
      // ==========================================
      console.log('\n📊 [1/7] Fetching chain snapshot...');
      const snapshot = await this.getChainSnapshot(chain, token_ca);

      if (!snapshot) {
        console.log('   ❌ Failed to get snapshot - REJECT');
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      console.log(`   ✅ Snapshot: Price=$${snapshot.current_price?.toFixed(10)}, Liquidity=$${(snapshot.liquidity_usd || 0).toFixed(0)}`);

      // Get Token Metadata (name, symbol, description) for Narrative detection
      let tokenMetadata = {
        token_ca,
        chain,
        name: null,
        symbol: symbol || null,  // Use signal symbol as fallback
        description: null
      };

      try {
        const service = chain === 'SOL' ? this.solService : this.bscService;

        // Only fetch metadata if service has getTokenMetadata method
        if (typeof service.getTokenMetadata === 'function') {
          const metadata = await service.getTokenMetadata(token_ca);
          tokenMetadata = {
            token_ca,
            chain,
            name: metadata.name || null,
            symbol: metadata.symbol || symbol || null,  // Fallback to signal symbol
            description: metadata.description || null
          };
        }
      } catch (error) {
        console.log(`   ⚠️  Token metadata fetch failed: ${error.message}`);
        // Continue with null metadata - Narrative score will be 0
      }

      // ==========================================
      // STEP 2: HARD GATES
      // ==========================================
      console.log('\n🚧 [2/7] Running hard gates...');
      const gateResult = await this.hardGateService.evaluate(snapshot, chain);

      // Handle REJECT status
      if (gateResult.status === 'REJECT') {
        const reasonText = (gateResult.reasons || []).join(', ') || 'Unknown reason';
        console.log(`   ❌ Hard gate REJECT: ${reasonText}`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      // Handle GREYLIST status
      if (gateResult.status === 'GREYLIST') {
        const reasonText = (gateResult.reasons || []).join(', ') || 'Unknown data';
        console.log(`   ⚠️  Hard gate GREYLIST: ${reasonText}`);
        // Continue processing but log as greylist
        this.stats.greylist_decisions++;
      } else {
        console.log(`   ✅ All hard gates passed (PASS)`);
        this.stats.hard_gate_passed++;
      }

      // ==========================================
      // STEP 3: SOFT ALPHA SCORE
      // ==========================================
      console.log('\n📈 [3/7] Computing soft alpha score...');

      // Collect Twitter data using Grok API
      let twitterData = null;
      try {
        console.log('   🐦 Searching Twitter via Grok API...');
        twitterData = await this.grokClient.searchToken(
          snapshot.symbol || token_ca.substring(0, 8),
          token_ca,
          15  // 15-minute window
        );
        console.log(`   ✅ Twitter: ${twitterData.mention_count} mentions, ${twitterData.engagement} engagement`);
      } catch (error) {
        console.log(`   ⚠️  Twitter search failed: ${error.message}`);
        // Continue without Twitter data
        twitterData = {
          mention_count: 0,
          unique_authors: 0,
          engagement: 0,
          sentiment: 'neutral',
          kol_count: 0
        };
      }

      // Collect Smart Money data
      let smartMoneyData = null;
      try {
        smartMoneyData = await this.smartMoneyTracker.getSmartMoneyScore(token_ca, chain);
        if (smartMoneyData.score !== 0) {
          console.log(`   🐋 Smart Money: ${smartMoneyData.reasons.join(', ')}`);
        }
      } catch (error) {
        console.log(`   ⚠️  Smart money check failed: ${error.message}`);
        smartMoneyData = { score: 0, reasons: ['数据获取失败'] };
      }

      // Prepare data structures for soft scorer
      // Get channel tier from database
      let channelTier = 'C'; // Default
      try {
        const channelInfo = this.db.prepare(`
          SELECT tier FROM telegram_channels 
          WHERE channel_name = ? OR channel_username LIKE ?
        `).get(signal.channel_name, `%${signal.channel_name}%`);
        if (channelInfo) {
          channelTier = channelInfo.tier;
        }
      } catch (e) {
        // Ignore, use default tier
      }

      // Calculate time lag (minutes since first mention)
      const signalTime = new Date(signal.timestamp).getTime();
      const timeLagMinutes = Math.floor((Date.now() - signalTime) / 60000);

      // ==========================================
      // 查询 15 分钟内有多少频道提到同一个 token（信号聚合）
      // ==========================================
      let tg_ch_15m = 1;
      let tg_clusters_15m = 1;
      let promotedChannels = [];
      
      try {
        const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - (15 * 60);
        
        // 查询 15 分钟内提到同一个 token 的所有信号
        const recentSignals = this.db.prepare(`
          SELECT DISTINCT channel_name, created_at
          FROM telegram_signals
          WHERE token_ca = ? AND created_at >= ?
          ORDER BY created_at ASC
        `).all(token_ca, fifteenMinutesAgo);
        
        if (recentSignals.length > 0) {
          tg_ch_15m = recentSignals.length;
          
          // 获取每个频道的 tier
          const uniqueChannels = [...new Set(recentSignals.map(s => s.channel_name))];
          tg_clusters_15m = uniqueChannels.length;
          
          promotedChannels = uniqueChannels.map(ch => {
            const chInfo = this.db.prepare(`
              SELECT tier FROM telegram_channels 
              WHERE channel_name = ? OR channel_username LIKE ?
            `).get(ch, `%${ch}%`);
            return {
              name: ch,
              tier: chInfo?.tier || 'C',
              timestamp: signalTime
            };
          });
          
          if (tg_ch_15m > 1) {
            console.log(`   📢 信号聚合: ${tg_ch_15m} 条信号来自 ${tg_clusters_15m} 个频道`);
          }
        }
      } catch (e) {
        console.log(`   ⚠️ 信号聚合查询失败: ${e.message}`);
      }

      const socialData = {
        // Telegram data - structured for scoring
        total_mentions: tg_ch_15m,
        unique_channels: tg_clusters_15m,
        tg_ch_15m: tg_ch_15m,  // 实际的频道数量（从数据库查询）
        tg_clusters_15m: tg_clusters_15m,  // 实际的独立频道数
        tg_velocity: tg_ch_15m > 1 ? tg_ch_15m / 15 : 0.5,  // 实际速度
        tg_accel: 0,
        tg_time_lag: timeLagMinutes,  // Minutes since first mention
        N_total: tg_ch_15m,
        
        // Channel info for AI Influencer System
        channel_name: signal.channel_name,
        
        // Promoted channels with tier info (required for Influence scoring)
        // 使用聚合后的所有频道
        promoted_channels: promotedChannels.length > 0 ? promotedChannels : [{
          name: signal.channel_name,
          tier: channelTier,
          timestamp: signalTime
        }],
        
        // Legacy field - 所有提到这个 token 的频道
        channels: promotedChannels.length > 0 
          ? promotedChannels.map(c => c.name) 
          : [signal.channel_name],
        message_timestamp: signal.timestamp,

        // Twitter data (from Grok API)
        twitter_mentions: twitterData.mention_count,
        twitter_unique_authors: twitterData.unique_authors,
        twitter_kol_count: twitterData.kol_count,
        twitter_engagement: twitterData.engagement,
        twitter_sentiment: twitterData.sentiment,
        top_tweets: twitterData.top_tweets || [],  // For KOL detection
        
        // X validation fields
        x_unique_authors_15m: twitterData.unique_authors,
        x_tier1_hit: twitterData.kol_count >= 1 ? 1 : 0,
        
        // ==========================================
        // 链上数据（从 snapshot 传入，用于 Graph 评分）
        // ==========================================
        chain_data: {
          liquidity_usd: snapshot.liquidity_usd || 0,
          top10_percent: snapshot.top10_percent || null,
          holder_count: snapshot.holder_count || null,
          current_price: snapshot.current_price || 0,
          // Pump.fun 特有数据
          is_pumpfun: snapshot.is_pumpfun || false,
          market_cap: snapshot.market_cap || 0,
          volume_24h: snapshot.volume_24h || 0,
          txns_24h: snapshot.txns_24h || 0,
          bonding_progress: snapshot.bonding_progress || 0
        }
      };

      // Use tokenMetadata (from Step 1) for Narrative detection
      // If metadata fetch failed, tokenMetadata will have null values
      const scoreResult = await this.softScorer.calculate(socialData, tokenMetadata);

      console.log(`   📊 Score: ${scoreResult.score}/100`);
      console.log(`   Components:`);
      console.log(`      - Narrative: ${scoreResult.breakdown.narrative.score.toFixed(1)}`);
      console.log(`      - Influence: ${scoreResult.breakdown.influence.score.toFixed(1)}`);
      console.log(`      - TG Spread: ${scoreResult.breakdown.tg_spread.score.toFixed(1)}`);
      console.log(`      - Graph: ${scoreResult.breakdown.graph.score.toFixed(1)}`);
      console.log(`      - Source: ${scoreResult.breakdown.source.score.toFixed(1)}`);

      this.stats.soft_score_computed++;

      // ==========================================
      // STEP 3.1: RISK MANAGER - SIGNAL EVALUATION
      // ==========================================
      console.log('\n🛡️ [3.1/7] Risk evaluation...');
      const riskEval = this.riskManager.evaluateSignal(signal, scoreResult.score, snapshot);
      
      if (!riskEval.allowed) {
        console.log(`   ❌ Risk rejected: ${riskEval.reason}`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }
      
      // Update score with time decay if applied
      if (riskEval.adjustedScore !== scoreResult.score) {
        console.log(`   ⚠️ 分数调整: ${scoreResult.score} → ${riskEval.adjustedScore.toFixed(0)} (${riskEval.reason})`);
        scoreResult.score = riskEval.adjustedScore;
      } else {
        console.log(`   ✅ Risk check passed: ${riskEval.reason}`);
      }
      
      // ==========================================
      // SHADOW MODE: Track price for source evaluation
      // ==========================================
      if (this.config.SHADOW_MODE && snapshot.current_price > 0) {
        // Get the signal outcome ID we recorded earlier
        const signalOutcomeId = this.lastSignalOutcomeId || null;
        
        this.shadowTracker.trackSignal(
          token_ca,
          chain,
          snapshot.current_price,
          snapshot.liquidity_usd || 0,
          'telegram',
          channel_name,
          signalOutcomeId
        );
      }

      // ==========================================
      // STEP 3.5: EXIT GATE (can we exit if we enter?)
      // ==========================================
      console.log('\n🚪 [3.5/7] Running exit gate...');
      
      // Get preliminary position size for slippage testing
      const preliminaryPositionSize = this.config.position_templates[chain]?.small?.sol || 
                                       this.config.position_templates[chain]?.small?.bnb || 0.5;
      
      const exitGateResult = this.exitGateService.evaluate(snapshot, preliminaryPositionSize);
      
      if (exitGateResult.status === 'REJECT') {
        const reasonText = (exitGateResult.reasons || []).join(', ') || 'Exit not feasible';
        console.log(`   ❌ Exit gate REJECT: ${reasonText}`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }
      
      if (exitGateResult.status === 'GREYLIST') {
        const reasonText = (exitGateResult.reasons || []).join(', ') || 'Exit uncertain';
        console.log(`   ⚠️  Exit gate GREYLIST: ${reasonText}`);
      } else {
        console.log(`   ✅ Exit gate passed (PASS)`);
      }

      // ==========================================
      // STEP 4: DECISION MATRIX
      // ==========================================
      console.log('\n🎯 [4/7] Making decision...');

      // Build evaluation object for decision engine
      const evaluation = {
        token_ca: token_ca,
        chain: chain,
        hard_gate: gateResult,
        exit_gate: exitGateResult,
        soft_score: scoreResult
      };

      const decision = this.decisionEngine.decide(evaluation);

      console.log(`   Decision: ${decision.action} (Rating: ${decision.rating})`);
      const reasonText = Array.isArray(decision.reasons) ? decision.reasons[0] : 'Unknown';
      console.log(`   Reason: ${reasonText}`);

      if (decision.action === 'REJECT') {
        console.log(`   ❌ Rejected`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      if (decision.action === 'WATCH_ONLY' || decision.action === 'WATCH') {
        console.log(`   ⚠️  Watch only - manual verification required`);
        this.markSignalProcessed(id);
        this.stats.greylist_decisions++;
        return;
      }

      // AUTO_BUY or BUY_WITH_CONFIRM
      if (decision.action === 'AUTO_BUY' || decision.action === 'BUY_WITH_CONFIRM') {
        console.log(`   ✅ BUY signal - proceeding to position sizing`);
        this.stats.buy_decisions++;
      } else {
        // Unexpected action - log warning
        console.log(`   ⚠️  Unexpected action: ${decision.action}`);
        this.markSignalProcessed(id);
        return;
      }

      // ==========================================
      // STEP 5: POSITION SIZING
      // ==========================================
      console.log('\n💰 [5/7] Calculating position size...');

      // Use tokenMetadata from Step 1
      const positionCheck = await this.positionSizer.canOpenPosition(decision, tokenMetadata);

      if (!positionCheck.allowed) {
        console.log(`   ❌ Cannot trade: ${positionCheck.reason}`);
        this.markSignalProcessed(id);
        return;
      }

      console.log(`   ✅ Position approved`);
      if (positionCheck.adjusted_size) {
        console.log(`      Size: ${positionCheck.adjusted_size.amount} ${chain}`);
        console.log(`      (~$${positionCheck.adjusted_size.usd_value} USD)`);
      }

      // ==========================================
      // STEP 6: EXECUTION
      // ==========================================
      console.log('\n⚡ [6/7] Executing trade...');

      const tradeParams = {
        chain,
        token_ca,
        position_size: positionCheck.adjusted_size || decision.position_size,
        max_slippage_bps: 500, // 5%
        symbol: snapshot.symbol || 'Unknown'
      };

      // Shadow mode or auto-buy disabled: record virtual position without execution
      if (this.config.SHADOW_MODE || !this.config.AUTO_BUY_ENABLED) {
        console.log(`   🎭 Shadow mode - Recording virtual position (no execution)`);
        
        const virtualExecutionResult = {
          success: true,
          trade_id: `shadow_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          method: 'shadow',
          tx_hash: null
        };
        
        const finalPositionSize = positionCheck.adjusted_size || tradeParams.position_size;
        this.recordPosition(signal, snapshot, scoreResult, finalPositionSize, virtualExecutionResult, true);
        this.stats.executions_success++;
        
      } else {
        // Live mode: execute real trade
        const executionResult = await this.executor.executeBuy(tradeParams);

        if (executionResult.success) {
          console.log(`   ✅ Execution successful!`);
          console.log(`      Trade ID: ${executionResult.trade_id}`);
          console.log(`      Method: ${executionResult.method}`);
          if (executionResult.tx_hash) {
            console.log(`      TX: ${executionResult.tx_hash}`);
          }
          this.stats.executions_success++;

          // Record position - use positionCheck.adjusted_size
          const finalPositionSize = positionCheck.adjusted_size || tradeParams.position_size;
          this.recordPosition(signal, snapshot, scoreResult, finalPositionSize, executionResult, false);

        } else {
          console.log(`   ❌ Execution failed: ${executionResult.error}`);
          this.stats.executions_failed++;
        }
      }

      // ==========================================
      // STEP 7: MARK PROCESSED
      // ==========================================
      this.markSignalProcessed(id);
      this.processedSignals.set(cacheKey, Date.now());

      console.log('\n✅ Signal processing complete');
      console.log('─'.repeat(80) + '\n');

    } catch (error) {
      console.error(`❌ Process signal error [${symbol}]:`, error.message);
      this.markSignalProcessed(id);
    }
  }

  /**
   * Get chain snapshot
   */
  async getChainSnapshot(chain, tokenCA) {
    try {
      const service = chain === 'SOL' ? this.solService : this.bscService;
      return await service.getSnapshot(tokenCA);
    } catch (error) {
      console.error('❌ Get snapshot error:', error.message);
      return null;
    }
  }

  /**
   * Record position in database
   * @param {boolean} isShadow - Whether this is a shadow/virtual position
   */
  recordPosition(signal, snapshot, scoreResult, positionSize, executionResult, isShadow = false) {
    try {
      // Handle positionSize - could be an object or a number
      let nativeSize, usdSize, confidence, kellyFraction;
      
      if (typeof positionSize === 'object' && positionSize !== null) {
        // positionSize is an object with detailed info
        nativeSize = positionSize.sol || positionSize.bnb || positionSize.amount || 0;
        usdSize = positionSize.usd_approx || positionSize.usd_value || 0;
        confidence = positionSize.confidence || null;
        kellyFraction = positionSize.kelly_fraction || null;
      } else {
        // positionSize is a number
        nativeSize = positionSize || 0;
        usdSize = 0;
        confidence = null;
        kellyFraction = null;
      }

      this.db.prepare(`
        INSERT INTO positions (
          chain, token_ca, symbol, signal_id,
          entry_time, entry_price, position_size_native, position_size_usd,
          alpha_score, confidence, kelly_fraction,
          entry_liquidity_usd, entry_top10_holders, entry_slippage_bps,
          entry_tg_accel, entry_risk_wallets,
          trade_id, entry_tx_hash, status, is_shadow
        ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `).run(
        signal.chain,
        signal.token_ca,
        snapshot.symbol || signal.token_ca.substring(0, 8),
        signal.id,
        snapshot.current_price || null,
        nativeSize,
        usdSize,
        scoreResult.score || scoreResult.final_score || 0,
        confidence,
        kellyFraction,
        snapshot.liquidity_usd || null,
        snapshot.top10_percent || null,
        snapshot.slippage_sell_20pct || null,
        scoreResult.breakdown?.tg_spread?.score || 0,
        JSON.stringify(snapshot.key_risk_wallets || []),
        executionResult.trade_id,
        executionResult.tx_hash || null,
        isShadow ? 1 : 0
      );

      console.log('   ✅ Position recorded in database');

    } catch (error) {
      console.error('❌ Record position error:', error.message);
    }
  }

  /**
   * Mark signal as processed
   */
  markSignalProcessed(signalId) {
    try {
      this.db.prepare(`
        UPDATE telegram_signals
        SET processed = 1
        WHERE id = ?
      `).run(signalId);
    } catch (error) {
      console.error('❌ Mark processed error:', error.message);
    }
  }

  /**
   * Inject GMGN smart money signal into database for processing
   */
  injectSignal(signal) {
    try {
      // 检查是否已存在（30分钟内）
      const existing = this.db.prepare(`
        SELECT id FROM telegram_signals 
        WHERE token_ca = ? AND chain = ? 
        AND created_at > ?
      `).get(
        signal.token_ca, 
        signal.chain,
        Math.floor(Date.now() / 1000) - 1800
      );
      
      if (existing) {
        return; // 已存在，跳过
      }
      
      // 插入新信号
      this.db.prepare(`
        INSERT INTO telegram_signals (
          token_ca, chain, channel_name, channel_username,
          message_text, timestamp, created_at, processed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        signal.token_ca,
        signal.chain,
        `GMGN_SmartMoney_${signal.smart_money_count}`,
        '@gmgn_smart_money',
        `🐋 Smart Money Signal: ${signal.symbol} - ${signal.smart_money_count} smart buyers`,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );
      
      console.log(`   ✅ GMGN 信号已注入: ${signal.symbol}`);
      
    } catch (error) {
      console.error('❌ Inject signal error:', error.message);
    }
  }

  /**
   * Stop the system
   */
  async stop() {
    console.log('\n⏹️  Stopping Sentiment Arbitrage System...\n');

    this.isRunning = false;

    if (this.signalInterval) {
      clearInterval(this.signalInterval);
    }

    await this.telegramService.stop();
    this.positionMonitor.stop();
    this.gmgnScout.stop();

    console.log('✅ System stopped\n');
    this.printStats();
  }

  /**
   * Print system statistics
   */
  printStats() {
    console.log('━'.repeat(80));
    console.log('📊 SESSION STATISTICS');
    console.log('━'.repeat(80));
    console.log(`Signals Received:      ${this.stats.signals_received}`);
    console.log(`Hard Gate Passed:      ${this.stats.hard_gate_passed}`);
    console.log(`Scores Computed:       ${this.stats.soft_score_computed}`);
    console.log(`Buy Decisions:         ${this.stats.buy_decisions}`);
    console.log(`Greylist Decisions:    ${this.stats.greylist_decisions}`);
    console.log(`Reject Decisions:      ${this.stats.reject_decisions}`);
    console.log(`Executions Success:    ${this.stats.executions_success}`);
    console.log(`Executions Failed:     ${this.stats.executions_failed}`);
    console.log('━'.repeat(80) + '\n');
  }

  /**
   * Get system status
   */
  getStatus() {
    return {
      is_running: this.isRunning,
      mode: this.config.SHADOW_MODE ? 'shadow' : 'live',
      auto_buy_enabled: this.config.AUTO_BUY_ENABLED,
      stats: this.stats,
      telegram_status: this.telegramService.getStatus(),
      monitor_status: this.positionMonitor.getStatus()
    };
  }
}

// ==========================================
// MAIN EXECUTION
// ==========================================

async function main() {
  const system = new SentimentArbitrageSystem();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Received SIGINT, shutting down gracefully...');
    await system.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Received SIGTERM, shutting down gracefully...');
    await system.stop();
    process.exit(0);
  });

  // Start system
  try {
    await system.start();
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

export { SentimentArbitrageSystem };
