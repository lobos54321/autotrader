/**
 * 风险管理系统
 * 
 * 核心职责：
 * 1. 入场标准控制（Score ≥ 70）
 * 2. 时间衰减因子
 * 3. 危险信号检测
 * 4. 资金管理（2% 上限，最多 3 仓，连亏暂停）
 * 5. 负反馈机制
 */

export class RiskManager {
  constructor(config, db) {
    this.config = config;
    this.db = db;

    // 风险参数
    this.params = {
      // 入场标准
      MIN_SCORE_TO_TRADE: 50, // 最低 50 分才能交易（从 70 降低，让更多信号进入模拟）
      
      // 时间衰减
      TIME_DECAY: {
        FRESH_MINUTES: 5,      // 5分钟内：满分
        STALE_MINUTES: 15,     // 5-15分钟：打折
        EXPIRED_MINUTES: 30,   // 30分钟后：不参与
        STALE_MULTIPLIER: 0.8, // 打 8 折
        EXPIRED_MULTIPLIER: 0  // 不参与
      },

      // 资金管理
      MAX_POSITION_PERCENT: 0.02,  // 单笔最多总资金 2%
      MAX_CONCURRENT_POSITIONS: 3, // 同时最多 3 仓
      
      // 负反馈机制
      CONSECUTIVE_LOSS_PAUSE: 3,   // 连亏 3 笔暂停
      PAUSE_DURATION_HOURS: 24,    // 暂停 24 小时
      WIN_RATE_THRESHOLD: 0.35,    // 胜率低于 35% 暂停
      MIN_TRADES_FOR_STATS: 10,    // 至少 10 笔交易才计算胜率

      // 危险信号权重
      DANGER_SIGNALS: {
        LP_UNLOCK_SOON: 10,        // LP 即将解锁
        OWNER_NOT_RENOUNCED: 5,    // 合约未放弃
        HIGH_TAX: 8,               // 高税率
        HONEYPOT_RISK: 20,         // 蜜罐风险
        DEV_HOLDING_HIGH: 7,       // 开发者持仓高
        SMART_MONEY_EXITING: 15,   // 聪明钱退出
        LIQUIDITY_DROPPING: 12,    // 流动性下降
        SOCIAL_DELETED: 20,        // 社交账号删除
      },
      MAX_DANGER_SCORE: 15,        // 危险分数超过 15 不交易
    };

    // 状态追踪
    this.state = {
      consecutiveLosses: 0,
      pausedUntil: null,
      todayTrades: 0,
      todayLosses: 0,
    };

    this.initializeState();
    console.log('🛡️  Risk Manager initialized');
    console.log(`   最低入场分数: ${this.params.MIN_SCORE_TO_TRADE}`);
    console.log(`   单笔上限: ${this.params.MAX_POSITION_PERCENT * 100}%`);
    console.log(`   最大持仓: ${this.params.MAX_CONCURRENT_POSITIONS}`);
    console.log(`   连亏暂停: ${this.params.CONSECUTIVE_LOSS_PAUSE} 笔`);
  }

  /**
   * 初始化状态（从数据库恢复）
   */
  initializeState() {
    try {
      // 获取连续亏损次数
      const recentTrades = this.db.prepare(`
        SELECT pnl_percent 
        FROM positions 
        WHERE status = 'closed'
        ORDER BY exit_time DESC
        LIMIT 10
      `).all();

      let consecutiveLosses = 0;
      for (const trade of recentTrades) {
        if (trade.pnl_percent < 0) {
          consecutiveLosses++;
        } else {
          break;
        }
      }
      this.state.consecutiveLosses = consecutiveLosses;

      // 检查是否在暂停期
      const pauseState = this.db.prepare(`
        SELECT value, expires_at FROM system_state WHERE key = 'trading_paused'
      `).get();

      if (pauseState && pauseState.expires_at > Date.now() / 1000) {
        this.state.pausedUntil = new Date(pauseState.expires_at * 1000);
      }

      console.log(`   当前连续亏损: ${this.state.consecutiveLosses}`);
      if (this.state.pausedUntil) {
        console.log(`   ⚠️ 交易暂停至: ${this.state.pausedUntil.toLocaleString()}`);
      }

    } catch (error) {
      // 忽略初始化错误
    }
  }

  /**
   * 检查是否可以交易
   * @returns {{ allowed: boolean, reason: string }}
   */
  canTrade() {
    // 1. 检查是否在暂停期
    if (this.state.pausedUntil && new Date() < this.state.pausedUntil) {
      const remaining = Math.ceil((this.state.pausedUntil - new Date()) / 1000 / 60);
      return {
        allowed: false,
        reason: `交易暂停中，还剩 ${remaining} 分钟`
      };
    }

    // 2. 检查连续亏损
    if (this.state.consecutiveLosses >= this.params.CONSECUTIVE_LOSS_PAUSE) {
      this.pauseTrading();
      return {
        allowed: false,
        reason: `连续亏损 ${this.state.consecutiveLosses} 笔，暂停 24 小时`
      };
    }

    // 3. 检查当前持仓数
    const openPositions = this.getOpenPositionsCount();
    if (openPositions >= this.params.MAX_CONCURRENT_POSITIONS) {
      return {
        allowed: false,
        reason: `已有 ${openPositions} 个持仓，达到上限 ${this.params.MAX_CONCURRENT_POSITIONS}`
      };
    }

    // 4. 检查历史胜率
    const stats = this.getRecentStats();
    if (stats.totalTrades >= this.params.MIN_TRADES_FOR_STATS) {
      if (stats.winRate < this.params.WIN_RATE_THRESHOLD) {
        return {
          allowed: false,
          reason: `近期胜率 ${(stats.winRate * 100).toFixed(1)}% 低于阈值 ${this.params.WIN_RATE_THRESHOLD * 100}%，需要复盘`
        };
      }
    }

    return { allowed: true, reason: 'OK' };
  }

  /**
   * 评估信号是否值得交易
   * @param {object} signal - 信号对象
   * @param {number} score - AI 评分
   * @param {object} snapshot - 链上快照
   * @returns {{ allowed: boolean, adjustedScore: number, reason: string }}
   */
  evaluateSignal(signal, score, snapshot) {
    let adjustedScore = score;
    const warnings = [];

    // 1. 基础分数检查
    if (score < this.params.MIN_SCORE_TO_TRADE) {
      return {
        allowed: false,
        adjustedScore: score,
        reason: `分数 ${score} < ${this.params.MIN_SCORE_TO_TRADE}（最低标准）`
      };
    }

    // 2. 时间衰减
    const signalAge = this.getSignalAgeMinutes(signal);
    if (signalAge > this.params.TIME_DECAY.EXPIRED_MINUTES) {
      return {
        allowed: false,
        adjustedScore: 0,
        reason: `信号已过期（${signalAge.toFixed(0)} 分钟前）`
      };
    } else if (signalAge > this.params.TIME_DECAY.STALE_MINUTES) {
      adjustedScore *= this.params.TIME_DECAY.STALE_MULTIPLIER;
      warnings.push(`时间衰减 -20%（${signalAge.toFixed(0)} 分钟）`);
    }

    // 3. 危险信号检测
    const dangerScore = this.calculateDangerScore(snapshot);
    if (dangerScore > this.params.MAX_DANGER_SCORE) {
      return {
        allowed: false,
        adjustedScore: adjustedScore,
        reason: `危险分数 ${dangerScore} > ${this.params.MAX_DANGER_SCORE}`
      };
    }
    if (dangerScore > 0) {
      warnings.push(`危险分数: ${dangerScore}`);
    }

    // 4. 调整后分数再次检查
    if (adjustedScore < this.params.MIN_SCORE_TO_TRADE) {
      return {
        allowed: false,
        adjustedScore: adjustedScore,
        reason: `调整后分数 ${adjustedScore.toFixed(0)} < ${this.params.MIN_SCORE_TO_TRADE}`
      };
    }

    return {
      allowed: true,
      adjustedScore: adjustedScore,
      reason: warnings.length > 0 ? `通过（${warnings.join(', ')}）` : '通过'
    };
  }

  /**
   * 计算信号年龄（分钟）
   */
  getSignalAgeMinutes(signal) {
    const signalTime = new Date(signal.timestamp).getTime();
    return (Date.now() - signalTime) / 1000 / 60;
  }

  /**
   * 计算危险分数
   */
  calculateDangerScore(snapshot) {
    let dangerScore = 0;

    if (!snapshot) return 0;

    // LP 未锁定或即将解锁
    if (snapshot.lp_locked === false || snapshot.lp_unlock_days < 7) {
      dangerScore += this.params.DANGER_SIGNALS.LP_UNLOCK_SOON;
    }

    // 合约未放弃
    if (snapshot.owner_type && !['Renounced', 'Burned'].includes(snapshot.owner_type)) {
      dangerScore += this.params.DANGER_SIGNALS.OWNER_NOT_RENOUNCED;
    }

    // 高税率
    const totalTax = (snapshot.tax_buy || 0) + (snapshot.tax_sell || 0);
    if (totalTax > 10) {
      dangerScore += this.params.DANGER_SIGNALS.HIGH_TAX;
    }

    // 蜜罐检测
    if (snapshot.honeypot === true || snapshot.is_honeypot === true) {
      dangerScore += this.params.DANGER_SIGNALS.HONEYPOT_RISK;
    }

    // 开发者持仓高
    if (snapshot.dev_holdings_percent > 10) {
      dangerScore += this.params.DANGER_SIGNALS.DEV_HOLDING_HIGH;
    }

    // Top10 持仓过高（可能是聪明钱准备出货）
    if (snapshot.top10_percent > 50) {
      dangerScore += this.params.DANGER_SIGNALS.SMART_MONEY_EXITING;
    }

    return dangerScore;
  }

  /**
   * 计算仓位大小
   * @param {string} chain - SOL/BSC
   * @param {number} score - 评分
   * @returns {{ size: number, unit: string }}
   */
  calculatePositionSize(chain, score) {
    const totalCapital = chain === 'SOL' 
      ? this.config.TOTAL_CAPITAL_SOL 
      : this.config.TOTAL_CAPITAL_BNB;

    // 最大单笔 = 总资金 * 2%
    let maxSize = totalCapital * this.params.MAX_POSITION_PERCENT;

    // 根据分数调整
    // 70-80分：50% 仓位
    // 80-90分：75% 仓位
    // 90-100分：100% 仓位
    let sizeMultiplier = 0.5;
    if (score >= 90) {
      sizeMultiplier = 1.0;
    } else if (score >= 80) {
      sizeMultiplier = 0.75;
    }

    const finalSize = maxSize * sizeMultiplier;

    return {
      size: finalSize,
      unit: chain,
      maxSize: maxSize,
      multiplier: sizeMultiplier
    };
  }

  /**
   * 记录交易结果
   */
  recordTradeResult(isWin) {
    if (isWin) {
      this.state.consecutiveLosses = 0;
    } else {
      this.state.consecutiveLosses++;
    }

    // 检查是否需要暂停
    if (this.state.consecutiveLosses >= this.params.CONSECUTIVE_LOSS_PAUSE) {
      this.pauseTrading();
    }
  }

  /**
   * 暂停交易
   */
  pauseTrading() {
    const pauseUntil = new Date();
    pauseUntil.setHours(pauseUntil.getHours() + this.params.PAUSE_DURATION_HOURS);
    this.state.pausedUntil = pauseUntil;

    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO system_state (key, value, expires_at)
        VALUES ('trading_paused', 'true', ?)
      `).run(Math.floor(pauseUntil.getTime() / 1000));
    } catch (error) {
      // 忽略
    }

    console.log(`\n⚠️  交易已暂停至 ${pauseUntil.toLocaleString()}`);
    console.log(`   原因：连续亏损 ${this.state.consecutiveLosses} 笔\n`);
  }

  /**
   * 获取当前持仓数
   */
  getOpenPositionsCount() {
    try {
      const result = this.db.prepare(`
        SELECT COUNT(*) as count FROM positions WHERE status IN ('open', 'breakeven')
      `).get();
      return result?.count || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * 获取近期统计
   */
  getRecentStats() {
    try {
      const stats = this.db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins
        FROM positions
        WHERE status = 'closed'
        AND created_at > strftime('%s', 'now', '-7 days')
      `).get();

      return {
        totalTrades: stats?.total || 0,
        wins: stats?.wins || 0,
        winRate: stats?.total > 0 ? stats.wins / stats.total : 0
      };
    } catch (error) {
      return { totalTrades: 0, wins: 0, winRate: 0 };
    }
  }

  /**
   * 获取状态
   */
  getStatus() {
    const stats = this.getRecentStats();
    return {
      canTrade: this.canTrade(),
      consecutiveLosses: this.state.consecutiveLosses,
      pausedUntil: this.state.pausedUntil,
      openPositions: this.getOpenPositionsCount(),
      maxPositions: this.params.MAX_CONCURRENT_POSITIONS,
      recentStats: stats,
      minScore: this.params.MIN_SCORE_TO_TRADE
    };
  }
}

export default RiskManager;
