/**
 * Position Monitor v3 - 翻倍出本 + AI动态管理策略 (MVP 3.0)
 *
 * 核心策略（猎手思维）：
 * 1. 止损：-50%（最大亏损底线）+ 时间止损（SOL 60min / BSC 2h）
 * 2. 翻倍出本：+100% 卖 50%（收回本金，剩余全是利润）
 * 3. 利润仓：AI 实时监控，动态决定卖出时机
 * 4. 紧急逃生：Dev出逃/聪明钱出逃/流动性崩溃 → 立即全卖
 *
 * 目标：翻倍出本，剩余死拿（Free Moonbag）
 */

import { SolanaSnapshotService } from '../inputs/chain-snapshot-sol.js';
import { BSCSnapshotService } from '../inputs/chain-snapshot-bsc.js';
import { GMGNTelegramExecutor } from './gmgn-telegram-executor.js';

export class PositionMonitorV2 {
  constructor(config, db) {
    this.config = config;
    this.db = db;

    // Services
    this.solService = new SolanaSnapshotService(config);
    this.bscService = new BSCSnapshotService(config);
    this.executor = new GMGNTelegramExecutor(config, db);

    // Monitor settings - 更频繁监控
    this.pollIntervalMs = config.POSITION_MONITOR_INTERVAL_MS || 60000; // 1 分钟
    this.isRunning = false;

    // MVP 3.0 猎手策略阈值
    this.strategy = {
      // 止损（铁律）
      STOP_LOSS: -0.50, // -50% 止损
      TIME_STOP_SOL_MINUTES: 60, // SOL 链 60分钟不涨就走
      TIME_STOP_BSC_MINUTES: 120, // BSC 链 2小时不涨就走

      // 翻倍出本（猎手思维）
      BREAKEVEN_TRIGGER: 1.00, // +100% 触发出本（翻倍）
      BREAKEVEN_SELL_PERCENT: 50, // 卖出 50%（收回本金）

      // 利润仓 AI 管理阈值
      HEAT_DECAY_THRESHOLD: 0.40, // 热度下降到入场时的 40%
      SMART_MONEY_EXIT_THRESHOLD: 0.10, // 聪明钱卖出 10%
      SIDEWAYS_TIMEOUT_MINUTES: 30, // 横盘超过 30 分钟
      MAX_DRAWDOWN_FROM_HIGH: 0.50, // 从最高点回撤 50%

      // 紧急退出（逃生系统）
      LIQUIDITY_CRASH_THRESHOLD: 0.50, // 流动性下降 50%
      DEV_DUMP_THRESHOLD: 0.10, // Dev 卖出超过 10% 持仓
      TOP_HOLDER_DUMP_THRESHOLD: 0.05, // Top10 1分钟内卖出 5% 总供应量
    };

    console.log('📊 Position Monitor v3 (MVP 3.0) initialized');
    console.log('   策略：翻倍出本 + AI动态管理');
    console.log(`   止损：${this.strategy.STOP_LOSS * 100}%`);
    console.log(`   时间止损：SOL ${this.strategy.TIME_STOP_SOL_MINUTES}min / BSC ${this.strategy.TIME_STOP_BSC_MINUTES}min`);
    console.log(`   翻倍出本：+${this.strategy.BREAKEVEN_TRIGGER * 100}% 卖 ${this.strategy.BREAKEVEN_SELL_PERCENT}%`);
    console.log(`   监控间隔：${this.pollIntervalMs / 1000}s`);
  }

  /**
   * 启动监控循环
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  Position Monitor already running');
      return;
    }

    this.isRunning = true;
    console.log('▶️  Position Monitor v3 started');

    // 初始监控
    await this.monitorAllPositions();

    // 循环监控
    this.monitorInterval = setInterval(async () => {
      try {
        await this.monitorAllPositions();
      } catch (error) {
        console.error('❌ Monitor loop error:', error.message);
      }
    }, this.pollIntervalMs);
  }

  /**
   * 停止监控
   */
  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isRunning = false;
    console.log('⏹️  Position Monitor v3 stopped');
  }

  /**
   * 监控所有持仓
   */
  async monitorAllPositions() {
    try {
      const positions = this.db.prepare(`
        SELECT * FROM positions
        WHERE status IN ('open', 'breakeven')
        ORDER BY entry_time ASC
      `).all();

      if (positions.length === 0) {
        return;
      }

      console.log(`\n🔍 [Monitor] 监控 ${positions.length} 个持仓...`);

      for (const position of positions) {
        await this.monitorPosition(position);
      }

    } catch (error) {
      console.error('❌ Monitor all positions error:', error.message);
    }
  }

  /**
   * 监控单个持仓
   */
  async monitorPosition(position) {
    const chain = position.chain;
    const tokenCA = position.token_ca;
    const symbol = position.symbol || tokenCA.substring(0, 8);
    const isShadow = position.is_shadow === 1;

    try {
      // 1. 获取当前快照
      const snapshot = await this.getChainSnapshot(chain, tokenCA);
      if (!snapshot || !snapshot.current_price) {
        console.log(`   ⚠️  [${symbol}] 获取快照失败，跳过`);
        return;
      }

      // 2. 计算盈亏
      const pnl = this.calculatePnL(position, snapshot.current_price);

      // 3. 更新最高价记录
      await this.updateHighWaterMark(position, snapshot.current_price);

      // 4. 获取市场信号
      const signals = await this.getMarketSignals(position, snapshot);

      // 5. 根据持仓状态决定策略
      let decision;
      if (position.status === 'open' && !position.breakeven_done) {
        // 未保本阶段
        decision = this.evaluatePreBreakeven(position, snapshot, pnl, signals);
      } else {
        // 已保本，利润仓阶段
        decision = this.evaluateProfitPosition(position, snapshot, pnl, signals);
      }

      // 6. 执行决策
      if (decision.action !== 'HOLD') {
        await this.executeDecision(position, decision, snapshot, pnl, isShadow);
      } else {
        const statusEmoji = position.breakeven_done ? '💰' : '📊';
        console.log(`   ${statusEmoji} [${symbol}] 持有 | PnL: ${pnl.pnl_percent >= 0 ? '+' : ''}${pnl.pnl_percent.toFixed(1)}% | ${decision.reason}`);
      }

    } catch (error) {
      console.error(`❌ Monitor position error [${symbol}]:`, error.message);
    }
  }

  /**
   * 未出本阶段的决策（翻倍前）
   */
  evaluatePreBreakeven(position, snapshot, pnl, signals) {
    const chain = position.chain;
    const entryTime = new Date(position.entry_time || position.created_at);
    const holdingMinutes = (Date.now() - entryTime.getTime()) / 1000 / 60;
    const timeStopMinutes = chain === 'SOL' 
      ? this.strategy.TIME_STOP_SOL_MINUTES 
      : this.strategy.TIME_STOP_BSC_MINUTES;

    // 1. 检查价格止损（铁律）
    if (pnl.pnl_percent <= this.strategy.STOP_LOSS * 100) {
      return {
        action: 'STOP_LOSS',
        sell_percent: 100,
        reason: `止损触发：${pnl.pnl_percent.toFixed(1)}% < ${this.strategy.STOP_LOSS * 100}%`
      };
    }

    // 2. 检查时间止损（逻辑证伪）
    if (holdingMinutes >= timeStopMinutes && pnl.pnl_percent < 20) {
      return {
        action: 'TIME_STOP',
        sell_percent: 100,
        reason: `时间止损：持仓${holdingMinutes.toFixed(0)}分钟未起飞（阈值${timeStopMinutes}min），逻辑证伪`
      };
    }

    // 3. 检查流动性崩溃
    if (signals.liquidity_ratio < this.strategy.LIQUIDITY_CRASH_THRESHOLD) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `流动性崩溃：${(signals.liquidity_ratio * 100).toFixed(0)}%`
      };
    }

    // 4. 检查 Dev 出逃
    if (signals.dev_dumping) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `🚨 Dev 出逃`
      };
    }

    // 5. 检查聪明钱出逃（一票否决）
    if (signals.smart_money_exit) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `🚨 聪明钱出逃`
      };
    }

    // 6. 检查翻倍出本触发
    if (pnl.pnl_percent >= this.strategy.BREAKEVEN_TRIGGER * 100) {
      return {
        action: 'BREAKEVEN',
        sell_percent: this.strategy.BREAKEVEN_SELL_PERCENT,
        reason: `🎯 翻倍出本：+${pnl.pnl_percent.toFixed(1)}% ≥ +${this.strategy.BREAKEVEN_TRIGGER * 100}%`
      };
    }

    return {
      action: 'HOLD',
      reason: `等待翻倍 (当前 ${pnl.pnl_percent >= 0 ? '+' : ''}${pnl.pnl_percent.toFixed(1)}%, 目标 +${this.strategy.BREAKEVEN_TRIGGER * 100}%, 持仓 ${holdingMinutes.toFixed(0)}min)`
    };
  }

  /**
   * 利润仓阶段的 AI 动态决策（Free Moonbag 阶段）
   */
  evaluateProfitPosition(position, snapshot, pnl, signals) {
    const reasons = [];
    let sellSignals = 0;

    // ========================================
    // 1. 紧急逃生条件（立即全卖，不问价格）
    // ========================================
    
    // 流动性崩溃
    if (signals.liquidity_ratio < this.strategy.LIQUIDITY_CRASH_THRESHOLD) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `🚨 流动性崩溃：${(signals.liquidity_ratio * 100).toFixed(0)}%`
      };
    }

    // Dev 出逃
    if (signals.dev_dumping) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `🚨 Dev 出逃：持仓下降 ${(Math.abs(signals.dev_balance_change) * 100).toFixed(0)}%`
      };
    }

    // 聪明钱出逃
    if (signals.smart_money_exit) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `🚨 聪明钱出逃`
      };
    }

    // Rug 迹象
    if (signals.rug_detected) {
      return {
        action: 'EMERGENCY_EXIT',
        sell_percent: 100,
        reason: `🚨 Rug 迹象`
      };
    }

    // ========================================
    // 2. 逐步卖出条件（每触发一个卖 1/3）
    // ========================================
    
    // 热度下降
    if (signals.heat_ratio < this.strategy.HEAT_DECAY_THRESHOLD) {
      sellSignals++;
      reasons.push(`热度↓${(signals.heat_ratio * 100).toFixed(0)}%`);
    }

    // 聪明钱减持
    if (signals.smart_money_selling) {
      sellSignals++;
      reasons.push(`聪明钱减持`);
    }

    // 横盘太久
    if (signals.sideways_minutes > this.strategy.SIDEWAYS_TIMEOUT_MINUTES) {
      sellSignals++;
      reasons.push(`横盘${signals.sideways_minutes.toFixed(0)}分钟`);
    }

    // 从最高点回撤过多
    if (signals.drawdown_from_high > this.strategy.MAX_DRAWDOWN_FROM_HIGH) {
      sellSignals++;
      reasons.push(`回撤${(signals.drawdown_from_high * 100).toFixed(0)}%`);
    }

    // 根据信号数量决定卖出比例
    if (sellSignals >= 3) {
      return {
        action: 'PROFIT_TAKE',
        sell_percent: 100, // 全卖
        reason: `多重信号 (${sellSignals}): ${reasons.join(', ')}`
      };
    } else if (sellSignals >= 2) {
      return {
        action: 'PROFIT_TAKE',
        sell_percent: 50, // 卖一半
        reason: `警告信号 (${sellSignals}): ${reasons.join(', ')}`
      };
    } else if (sellSignals >= 1) {
      return {
        action: 'PROFIT_TAKE',
        sell_percent: 33, // 卖 1/3
        reason: `信号: ${reasons.join(', ')}`
      };
    }

    // ========================================
    // 3. 继续持有条件（死拿等百倍）
    // ========================================
    const holdReasons = [];
    if (signals.heat_rising) holdReasons.push('热度↑');
    if (signals.smart_money_buying) holdReasons.push('聪明钱加仓');
    if (signals.new_catalyst) holdReasons.push('新催化剂');
    if (signals.liquidity_healthy) holdReasons.push('流动性健康');

    return {
      action: 'HOLD',
      reason: holdReasons.length > 0 ? `🚀 死拿: ${holdReasons.join(', ')}` : '无卖出信号，继续持有'
    };
  }

  /**
   * 获取市场信号（MVP 3.0 增强版）
   */
  async getMarketSignals(position, snapshot) {
    const signals = {
      // 流动性
      liquidity_ratio: 1.0,
      liquidity_healthy: true,

      // 热度
      heat_ratio: 1.0,
      heat_rising: false,

      // 聪明钱
      smart_money_selling: false,
      smart_money_buying: false,
      smart_money_exit: false,

      // Dev 监控（新增）
      dev_dumping: false,
      dev_balance_change: 0,

      // 价格
      drawdown_from_high: 0,
      sideways_minutes: 0,

      // 风险
      rug_detected: false,
      new_catalyst: false,
    };

    try {
      // 流动性比较
      const entryLiquidity = position.entry_liquidity_usd || snapshot.liquidity_usd;
      if (entryLiquidity > 0) {
        signals.liquidity_ratio = (snapshot.liquidity_usd || 0) / entryLiquidity;
        signals.liquidity_healthy = signals.liquidity_ratio >= 0.7;
      }

      // 最高价回撤
      const highPrice = position.high_water_mark || position.entry_price;
      if (highPrice > 0) {
        signals.drawdown_from_high = (highPrice - snapshot.current_price) / highPrice;
      }

      // 热度比较（从 TG 信号表）
      const currentHeat = await this.getCurrentHeat(position.token_ca);
      const entryHeat = position.entry_tg_accel || 1;
      if (entryHeat > 0) {
        signals.heat_ratio = currentHeat / entryHeat;
        signals.heat_rising = signals.heat_ratio > 1.2;
      }

      // 横盘检测
      signals.sideways_minutes = this.calculateSidewaysTime(position);

      // 聪明钱动向（基于 Top10 变化）
      const entryTop10 = position.entry_top10_holders || 0;
      const currentTop10 = snapshot.top10_percent || 0;
      const top10Change = currentTop10 - entryTop10;
      
      if (top10Change > 10) {
        signals.smart_money_buying = true;
      } else if (top10Change < -15) {
        signals.smart_money_selling = true;
      }
      
      // 聪明钱出逃判定（Top10 快速下降超过 30%）
      if (top10Change < -30) {
        signals.smart_money_exit = true;
      }

      // Dev 监控（简化版 - 基于 Top1 持仓变化）
      // 如果 Top1 持仓大幅下降（假设 Top1 是 Dev）
      const entryTop1 = position.entry_top1_holder || 0;
      const currentTop1 = snapshot.top1_percent || 0;
      if (entryTop1 > 0 && currentTop1 < entryTop1 * 0.9) {
        // Top1 持仓下降超过 10%
        signals.dev_dumping = true;
        signals.dev_balance_change = (currentTop1 - entryTop1) / entryTop1;
      }

    } catch (error) {
      console.error('❌ Get market signals error:', error.message);
    }

    return signals;
  }

  /**
   * 获取当前热度
   */
  async getCurrentHeat(tokenCA) {
    try {
      const result = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM telegram_signals
        WHERE token_ca = ?
        AND created_at > strftime('%s', 'now', '-15 minutes')
      `).get(tokenCA);
      return result?.count || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * 计算横盘时间
   */
  calculateSidewaysTime(position) {
    if (!position.last_significant_move) {
      return 0;
    }
    const lastMove = new Date(position.last_significant_move);
    const now = new Date();
    return (now - lastMove) / 1000 / 60; // 分钟
  }

  /**
   * 更新最高价记录
   */
  async updateHighWaterMark(position, currentPrice) {
    try {
      const highWaterMark = position.high_water_mark || position.entry_price || 0;
      if (currentPrice > highWaterMark) {
        this.db.prepare(`
          UPDATE positions
          SET high_water_mark = ?,
              last_significant_move = datetime('now')
          WHERE id = ?
        `).run(currentPrice, position.id);
      }
    } catch (error) {
      // 忽略
    }
  }

  /**
   * 执行决策
   */
  async executeDecision(position, decision, snapshot, pnl, isShadow) {
    const symbol = position.symbol || position.token_ca.substring(0, 8);
    const { action, sell_percent, reason } = decision;

    console.log(`\n🎯 [${symbol}] ${action}`);
    console.log(`   原因: ${reason}`);
    console.log(`   卖出: ${sell_percent}%`);
    console.log(`   PnL: ${pnl.pnl_percent >= 0 ? '+' : ''}${pnl.pnl_percent.toFixed(2)}%`);

    if (isShadow || this.config.SHADOW_MODE) {
      // Shadow 模式：只记录，不执行
      await this.recordShadowTrade(position, decision, snapshot, pnl);
    } else {
      // 实盘模式：执行卖出
      await this.executeRealTrade(position, decision, snapshot, pnl);
    }
  }

  /**
   * 记录 Shadow 交易
   */
  async recordShadowTrade(position, decision, snapshot, pnl) {
    const { action, sell_percent } = decision;
    const sellAmount = (position.remaining_percent || 100) * sell_percent / 100;
    const newRemaining = (position.remaining_percent || 100) - sellAmount;

    try {
      if (action === 'BREAKEVEN') {
        // 保本操作
        this.db.prepare(`
          UPDATE positions
          SET breakeven_done = 1,
              breakeven_time = datetime('now'),
              breakeven_price = ?,
              breakeven_sell_percent = ?,
              remaining_percent = ?,
              status = 'breakeven',
              updated_at = strftime('%s', 'now')
          WHERE id = ?
        `).run(
          snapshot.current_price,
          sell_percent,
          newRemaining,
          position.id
        );
        console.log(`   ✅ [Shadow] 保本完成，剩余 ${newRemaining.toFixed(0)}% 利润仓`);

      } else if (sell_percent >= 100 || newRemaining <= 0) {
        // 全部卖出
        this.db.prepare(`
          UPDATE positions
          SET status = 'closed',
              exit_time = datetime('now'),
              exit_price = ?,
              exit_type = ?,
              pnl_percent = ?,
              remaining_percent = 0,
              updated_at = strftime('%s', 'now')
          WHERE id = ?
        `).run(
          snapshot.current_price,
          action,
          pnl.pnl_percent,
          position.id
        );
        console.log(`   ✅ [Shadow] 仓位已平，PnL: ${pnl.pnl_percent >= 0 ? '+' : ''}${pnl.pnl_percent.toFixed(2)}%`);

      } else {
        // 部分卖出
        this.db.prepare(`
          UPDATE positions
          SET remaining_percent = ?,
              last_partial_sell_time = datetime('now'),
              last_partial_sell_price = ?,
              updated_at = strftime('%s', 'now')
          WHERE id = ?
        `).run(
          newRemaining,
          snapshot.current_price,
          position.id
        );
        console.log(`   ✅ [Shadow] 部分卖出 ${sellAmount.toFixed(0)}%，剩余 ${newRemaining.toFixed(0)}%`);
      }

    } catch (error) {
      console.error('❌ Record shadow trade error:', error.message);
    }
  }

  /**
   * 执行实盘交易
   */
  async executeRealTrade(position, decision, snapshot, pnl) {
    const { action, sell_percent } = decision;

    try {
      const sellResult = await this.executor.executeSell({
        chain: position.chain,
        token_ca: position.token_ca,
        sell_percent: sell_percent,
        position_id: position.id
      });

      if (sellResult.success) {
        // 更新数据库（与 shadow 类似）
        await this.recordShadowTrade(position, decision, snapshot, pnl);
        console.log(`   ✅ [Live] 交易执行成功，TX: ${sellResult.tx_hash || 'pending'}`);
      } else {
        console.error(`   ❌ [Live] 交易执行失败: ${sellResult.error}`);
      }

    } catch (error) {
      console.error('❌ Execute real trade error:', error.message);
    }
  }

  /**
   * 获取链上快照
   */
  async getChainSnapshot(chain, tokenCA) {
    try {
      const service = chain === 'SOL' ? this.solService : this.bscService;
      return await service.getSnapshot(tokenCA);
    } catch (error) {
      return null;
    }
  }

  /**
   * 计算盈亏
   */
  calculatePnL(position, currentPrice) {
    const entryPrice = position.entry_price || 0;
    if (entryPrice === 0 || currentPrice === 0) {
      return { pnl_percent: 0, pnl_native: 0 };
    }

    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const remainingPercent = position.remaining_percent || 100;
    const effectivePnl = pnlPercent * remainingPercent / 100;

    return {
      current_price: currentPrice,
      entry_price: entryPrice,
      pnl_percent: pnlPercent,
      effective_pnl: effectivePnl,
      remaining_percent: remainingPercent
    };
  }

  /**
   * 获取状态
   */
  getStatus() {
    try {
      const stats = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
          SUM(CASE WHEN status = 'breakeven' THEN 1 ELSE 0 END) as breakeven,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
        FROM positions
      `).get();

      return {
        is_running: this.isRunning,
        strategy: 'v3 - 翻倍出本 + AI动态管理 (MVP 3.0)',
        positions: stats
      };
    } catch (error) {
      return { is_running: this.isRunning, error: error.message };
    }
  }
}

export default PositionMonitorV2;
