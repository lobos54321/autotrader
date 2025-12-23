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
import { DexScreenerScout } from './inputs/dexscreener-scout.js';
import { GMGNPlaywrightScout } from './inputs/gmgn-playwright-scout.js';
import { DebotPlaywrightScout } from './inputs/debot-playwright-scout.js';
import debotScout from './inputs/debot-scout.js';
import { CrossValidator } from './engines/cross-validator.js';

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
    
    // DexScreener Scout - 免费信号源（无需 Cookie！）
    this.dexScreenerScout = new DexScreenerScout({
      chains: ['solana', 'bsc'],
      pollInterval: 60000,  // 1分钟轮询
      minLiquidity: 10000   // 最低 $10k 流动性
    });
    
    // GMGN Playwright Scout - 聪明钱/KOL 信号源（使用 Playwright 拦截）
    this.gmgnScout = new GMGNPlaywrightScout({
      chains: ['sol'],
      headless: process.env.NODE_ENV === 'production'
    });
    
    // DeBot Playwright Scout - 聪明钱追踪
    this.debotScout = new DebotPlaywrightScout({
      chains: ['sol', 'bsc'],
      headless: process.env.NODE_ENV === 'production'
    });
    
    // DeBot API Scout - 主力信号源 (API 模式，更稳定)
    this.debotApiScout = debotScout;
    
    // Cross Validator - 交叉验证系统 (DeBot主力 + TG辅助)
    this.crossValidator = new CrossValidator();
    
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

      // 1. Start Telegram listener (可选)
      if (process.env.TELEGRAM_ENABLED !== 'false') {
        console.log('📱 Starting Telegram signal listener...');
        try {
          await this.telegramService.start();
          console.log('   ✅ Telegram listener active\n');
        } catch (err) {
          console.log(`   ⚠️ Telegram 启动失败: ${err.message}`);
          console.log('   跳过 Telegram，继续运行其他模块...\n');
        }
      } else {
        console.log('📱 Telegram listener: ❌ 已禁用\n');
      }

      // 2. Start position monitor
      console.log('📊 Starting position monitor...');
      await this.positionMonitor.start();
      console.log('   ✅ Position monitor active\n');

      // 2.5 Start DexScreener Scout (免费 API - 无需 Cookie!)
      if (process.env.DEXSCREENER_ENABLED === 'true') {
        console.log('📊 Starting DexScreener Scout...');
        await this.dexScreenerScout.start();
        this.dexScreenerScout.on('signal', (signal) => {
          console.log(`\n${signal.emoji} [DexScreener] ${signal.symbol} (${signal.chain})`);
          this.injectSignal(signal);
        });
        console.log('   ✅ DexScreener Scout active\n');
      }

      // 2.6 Start GMGN Playwright Scout (聪明钱/KOL - Playwright 模式)
      if (process.env.GMGN_ENABLED === 'true') {
        console.log('🐋 Starting GMGN Playwright Scout...');
        
        if (!this.gmgnScout.hasSession()) {
          console.log('   ⚠️ 未找到 GMGN Session!');
          console.log('   请先运行: node scripts/gmgn-login-setup.js');
          console.log('   跳过 GMGN Scout\n');
        } else {
          await this.gmgnScout.start();
          this.gmgnScout.on('signal', (signal) => {
            const info = signal.signal_type === 'smart_money' ? `${signal.smart_money_count || 0} 个聪明钱` :
                         signal.signal_type === 'kol' ? `${signal.kol_count || 0} 个KOL` :
                         signal.signal_type === 'surge' ? `5m +${(signal.price_change_5m || 0).toFixed(1)}%` :
                         signal.signal_type === 'signal' ? '新信号' : '';
            console.log(`\n${signal.emoji} [GMGN ${signal.signal_type.toUpperCase()}] ${signal.symbol} (${signal.chain}) - ${info}`);
            this.injectSignal(signal);
          });
          console.log('   ✅ GMGN Playwright Scout active');
          console.log('      - 🐋 Smart Money (聪明钱)');
          console.log('      - 👑 KOL (KOL持仓)');
          console.log('      - 🚀 Surge (飙升榜)');
          console.log('      - 📡 Signals (信号)\n');
        }
      }

      // 2.7 Start DeBot Playwright Scout (聪明钱追踪) + CrossValidator v2.0
      if (process.env.DEBOT_ENABLED === 'true') {
        console.log('🕵️ Starting DeBot Playwright Scout + CrossValidator v2.0...');
        
        if (!this.debotScout.hasSession()) {
          console.log('   ⚠️ 未找到 DeBot Session!');
          console.log('   请先运行: node scripts/debot-login-setup.js');
          console.log('   跳过 DeBot Scout\n');
        } else {
          // 启动 CrossValidator v2.0
          this.crossValidator.start();
          
          await this.debotScout.start();
          
          // 将 Playwright Scout 的信号发送到 CrossValidator
          this.debotScout.on('signal', async (signal) => {
            // 转换为 CrossValidator 期望的 token 格式
            const token = {
              tokenAddress: signal.tokenAddress || signal.token_ca,
              chain: signal.chain,
              symbol: signal.symbol || signal.tokenName || signal.tokenAddress?.slice(0, 8),
              smartWalletOnline: signal.smartMoneyCount || signal.smart_wallet_online || signal.smart_money_count || 0,
              smartWalletTotal: signal.smart_wallet_total || 0,
              liquidity: signal.liquidity || 0,
              marketCap: signal.marketCap || 0,
              price: signal.price || 0,
              holders: signal.holders || 0,
              volume: signal.volume || 0,
              signalCount: signal.signalCount || signal.alertCount || 1,
              maxPriceGain: signal.maxPriceGain || 0,
              tokenLevel: signal.tokenLevel || signal.tokenTier || 'unknown',
              isMintAbandoned: signal.isMintAbandoned !== false,
              aiReport: signal.aiReport || null
            };
            
            // 简要日志
            const emoji = signal.tokenLevel === 'gold' ? '🥇' : 
                          signal.tokenLevel === 'silver' ? '🥈' : '🥉';
            console.log(`\n${emoji} [DeBot → Validator] ${token.symbol} (${token.chain})`);
            console.log(`   🐋 聪明钱: ${token.smartWalletOnline} | 📊 信号: ${token.signalCount}次 | 💰 流动性: $${(token.liquidity/1000).toFixed(1)}K`);
            
            // 发送到 CrossValidator 进行评分
            await this.crossValidator.onNewToken(token);
          });
          
          // 监听 CrossValidator 验证通过的信号
          this.crossValidator.on('validated-signal', async (result) => {
            const { token, score, decision, llmResult } = result;
            
            console.log(`\n🎯 [CrossValidator] 验证完成: ${token.symbol}`);
            console.log(`   📊 总分: ${score.total}/100`);
            console.log(`   🎯 决策: ${decision.action} ${decision.tier ? `(${decision.tier})` : ''}`);
            
            // 如果决策是买入，注入到执行流程
            if (decision.action === 'BUY') {
              console.log(`   💰 仓位: ${decision.position} SOL`);
              
              this.injectValidatedSignal({
                token: {
                  address: token.tokenAddress,
                  symbol: token.symbol,
                  chain: token.chain
                },
                action: decision.tier === 'MAX' ? 'BUY_MAX' : 
                        decision.tier === 'NORMAL' ? 'BUY_NORMAL' : 'BUY_SMALL',
                rating: decision.tier,
                positionSize: decision.position,
                reasons: [decision.reason],
                validation: {
                  smartMoney: {
                    online: token.smartWalletOnline || 0,
                    total: token.smartWalletTotal || 0
                  },
                  aiScore: result.aiReport?.rating?.score || 0,
                  llmScore: llmResult?.score || null,
                  tgHeat: {
                    count: result.tgHeat?.mentionCount || 0
                  },
                  score: score
                }
              });
            }
          });
          
          console.log('   ✅ DeBot Playwright Scout + CrossValidator v2.0 active');
          console.log('      - 🔥 Hot Tokens → CrossValidator');
          console.log('      - 🤖 AI Signals → CrossValidator');
          console.log('      - 📊 评分: 聪明钱40% + AI叙事25% + TG共识15% + 动量10% + 安全10%');
          console.log('      - 🧠 LLM分析: ' + (process.env.AI_ANALYSIS_ENABLED === 'true' ? '✅ 已启用' : '❌ 未启用') + '\n');
        }
      }

      // 2.8 Start Legacy Scout Engine (可选)
      if (process.env.SCOUT_ENABLED === 'true') {
        console.log('🔭 Starting Legacy Smart Money Scout...');
        await this.smartMoneyScout.start();
        console.log('   ✅ Legacy Scout engine active\n');
      }

      // 2.9 Start DeBot API Scout (主力信号源 - 推荐)
      if (process.env.DEBOT_API_ENABLED === 'true') {
        console.log('🎯 Starting DeBot API Scout (主力信号源)...');
        
        // 初始化交叉验证器
        this.crossValidator.start();
        
        // 启动 DeBot Scout
        this.debotApiScout.start();
        
        // 监听交叉验证器的验证信号
        this.crossValidator.on('validated-signal', async (result) => {
          const { token, score, decision } = result;
          
          console.log(`\n🎯 [CrossValidator] 验证通过: ${token.symbol}`);
          console.log(`   评分: ${score.total}/100`);
          console.log(`   决策: ${decision.action} (${decision.tier})`);
          console.log(`   仓位: ${decision.position} SOL`);
          
          // 如果决策是买入，注入信号
          if (decision.action === 'BUY') {
            this.injectValidatedSignal({
              token: {
                address: token.tokenAddress,
                symbol: token.symbol,
                chain: token.chain
              },
              action: decision.tier === 'MAX' ? 'BUY_MAX' : 
                      decision.tier === 'TREND' ? 'BUY_NORMAL' : 'BUY_SMALL',
              rating: decision.tier,
              positionSize: decision.position,
              reasons: [decision.reason],
              validation: {
                smartMoney: {
                  online: token.smartWalletOnline || 0,
                  total: token.smartWalletTotal || 0
                },
                aiScore: result.aiReport?.rating?.score || 0,
                tgHeat: {
                  count: result.tgHeat?.mentionCount || 0
                }
              }
            });
          }
        });
        
        console.log('   ✅ DeBot API Scout + CrossValidator active');
        console.log('      - 🔥 Hot Tokens (热门代币)');
        console.log('      - 🎯 AI Signals (AI信号)');
        console.log('      - 📊 Cross Validation (交叉验证)');
        console.log('      - 🧮 Scoring: 聪明钱40% + AI叙事30% + TG共识20% + 安全10%\n');
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
  /**
   * Process individual signal through simplified pipeline
   * 旧 Telegram 流程简化版：Hard Gates → 转给 CrossValidator
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

      // 检查信号源质量
      const shouldUse = this.sourceOptimizer.shouldUseSource('telegram', channel_name);
      if (!shouldUse) {
        this.markSignalProcessed(id);
        return;
      }

      console.log('\n' + '─'.repeat(80));
      console.log(`🔔 NEW SIGNAL: ${symbol} (${chain}) from ${channel_name}`);
      console.log('─'.repeat(80));

      this.stats.signals_received++;
      
      // 风险管理检查
      const canTradeCheck = this.riskManager.canTrade();
      if (!canTradeCheck.allowed) {
        console.log(`\n🛡️ [Risk] 无法交易: ${canTradeCheck.reason}`);
        this.markSignalProcessed(id);
        return;
      }

      // 永久黑名单检查
      const blacklistRecord = this.blacklistService.isBlacklisted(token_ca, chain);
      if (blacklistRecord) {
        console.log(`\n🚫 BLACKLIST: ${blacklistRecord.blacklist_reason}`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      // 获取链上快照
      console.log('\n📊 [1/2] Fetching chain snapshot...');
      const snapshot = await this.getChainSnapshot(chain, token_ca);

      if (!snapshot) {
        console.log('   ❌ Failed to get snapshot - REJECT');
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      console.log(`   ✅ Snapshot: Price=$${snapshot.current_price?.toFixed(10)}, Liquidity=$${(snapshot.liquidity_usd || 0).toFixed(0)}`);

      // Hard Gates 检查
      console.log('\n🚧 [2/2] Running hard gates...');
      const gateResult = await this.hardGateService.evaluate(snapshot, chain);

      if (gateResult.status === 'REJECT') {
        const reasonText = (gateResult.reasons || []).join(', ') || 'Unknown reason';
        console.log(`   ❌ Hard gate REJECT: ${reasonText}`);
        this.markSignalProcessed(id);
        this.stats.reject_decisions++;
        return;
      }

      if (gateResult.status === 'GREYLIST') {
        console.log(`   ⚠️  Hard gate GREYLIST: ${(gateResult.reasons || []).join(', ')}`);
        this.stats.greylist_decisions++;
      } else {
        console.log(`   ✅ Hard gates passed`);
        this.stats.hard_gate_passed++;
      }

      // 查询 15 分钟内同 token 的 TG 提及数
      let tgMentions = 1;
      try {
        const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - (15 * 60);
        const recentSignals = this.db.prepare(`
          SELECT COUNT(DISTINCT channel_name) as cnt
          FROM telegram_signals
          WHERE token_ca = ? AND created_at >= ?
        `).get(token_ca, fifteenMinutesAgo);
        tgMentions = recentSignals?.cnt || 1;
      } catch (e) {
        // 忽略
      }

      // 转给 CrossValidator 处理
      console.log(`\n➡️ 转交 CrossValidator 评分...`);
      
      const tokenForValidator = {
        tokenAddress: token_ca,
        chain: chain,
        symbol: snapshot.symbol || symbol,
        smartWalletOnline: snapshot.smart_money_count || 0,
        smartWalletTotal: snapshot.smart_money_total || 0,
        liquidity: snapshot.liquidity_usd || 0,
        isMintAbandoned: snapshot.mint_abandoned !== false,
        signalCount: tgMentions,
        price: snapshot.current_price || 0,
        marketCap: snapshot.market_cap || 0,
        source: `TG:${channel_name}`
      };

      // 调用 CrossValidator
      await this.crossValidator.onNewToken(tokenForValidator);

      // 标记已处理
      this.processedSignals.set(cacheKey, Date.now());
      this.markSignalProcessed(id);

    } catch (error) {
      console.error(`❌ Process signal error: ${error.message}`);
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
   * Inject validated signal from CrossValidator
   * 已经过交叉验证的信号，直接进入执行流程
   */
  injectValidatedSignal(decision) {
    try {
      const token = decision.token;
      const isShadow = this.config.SHADOW_MODE;
      
      // 检查是否已存在（15分钟内）
      const existing = this.db.prepare(`
        SELECT id FROM positions 
        WHERE token_ca = ? AND chain = ? 
        AND entry_time > datetime('now', '-15 minutes')
      `).get(token.address, token.chain);
      
      if (existing) {
        console.log(`   ⏭️ 已持有该币，跳过: ${token.symbol}`);
        return;
      }
      
      // 根据决策类型设置级别
      const tierName = decision.rating === 'PREMIUM' ? 'S_Signal' :
                       decision.rating === 'NORMAL' ? 'A_Signal' : 'Scout';
      
      // 生成模拟交易 ID
      const tradeId = Date.now();
      
      // 直接写入 positions 表（Shadow 模式的模拟交易）
      this.db.prepare(`
        INSERT INTO positions (
          chain, token_ca, symbol, signal_id,
          entry_time, entry_price, position_size_native, position_size_usd,
          alpha_score, status, is_shadow
        ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'open', ?)
      `).run(
        token.chain,
        token.address,
        token.symbol,
        tradeId,
        0,  // entry_price 后续会更新
        decision.positionSize,  // position_size_native (SOL)
        decision.positionSize * 200,  // 估算 USD (假设 SOL=$200)
        decision.validation?.score?.total || 0,  // alpha_score
        isShadow ? 1 : 0
      );
      
      console.log(`   ✅ 模拟买入: ${token.symbol} (${decision.rating}级, ${decision.positionSize} SOL)`);
      
      // 同时记录到 telegram_signals 表（用于历史追踪）
      const channelName = `DeBot_${tierName}`;
      const messageText = [
        `${decision.rating === 'PREMIUM' ? '🚀' : decision.rating === 'NORMAL' ? '✅' : '🐦'} DeBot 验证信号`,
        `代币: ${token.symbol}`,
        `评级: ${decision.rating}`,
        `仓位: ${decision.positionSize} SOL`,
        `聪明钱: ${decision.validation.smartMoney.online}/${decision.validation.smartMoney.total}`,
        `AI评分: ${decision.validation.aiScore}/10`,
        `TG热度: ${decision.validation.tgHeat.count}次提及`,
        `总分: ${decision.validation?.score?.total || 0}分`,
        `理由: ${decision.reasons.slice(0, 2).join('; ')}`
      ].join('\n');
      
      this.db.prepare(`
        INSERT INTO telegram_signals (
          token_ca, chain, channel_name, channel_username,
          message_text, timestamp, created_at, processed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        token.address,
        token.chain,
        channelName,
        '@debot_validated',
        messageText,
        new Date().toISOString(),
        Math.floor(Date.now() / 1000)
      );
      
    } catch (error) {
      console.error('❌ Inject validated signal error:', error.message);
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
    this.dexScreenerScout.stop();

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
