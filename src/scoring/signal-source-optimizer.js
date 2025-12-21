/**
 * Adaptive Signal Source Optimizer
 * 
 * 核心目标：
 * 1. 持续发现新的信号源
 * 2. 追踪每个信号源的实际表现（胜率、PnL）
 * 3. 自动淘汰低质量信号源
 * 4. 保持 TOP N 个高质量信号源
 * 5. 提高整体胜率和收益
 * 
 * 工作流程：
 * - 每日：更新信号源表现数据
 * - 每周：发现新源、淘汰差源、保持最优 N 个
 * - 实时：根据信号源质量调整评分权重
 */

export class SignalSourceOptimizer {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    
    // 配置
    this.MAX_ACTIVE_SOURCES = config.max_active_sources || 10;  // 保持 10 个高质量源
    this.MIN_SIGNALS_FOR_EVAL = config.min_signals_for_eval || 10;  // 至少 10 个信号才评估
    this.MIN_WIN_RATE = config.min_win_rate || 0.3;  // 最低 30% 胜率
    this.MIN_AVG_PNL = config.min_avg_pnl || -0.1;  // 最低 -10% 平均收益
    this.PROBATION_DAYS = config.probation_days || 7;  // 新源观察期 7 天
    
    // 初始化数据库表
    this.initializeDatabase();
  }

  /**
   * 初始化信号源追踪表
   */
  initializeDatabase() {
    this.db.exec(`
      -- 信号源表现追踪表
      CREATE TABLE IF NOT EXISTS signal_source_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,           -- 'telegram' or 'twitter_kol'
        source_id TEXT NOT NULL,             -- channel username or KOL handle
        source_name TEXT,
        
        -- 状态
        status TEXT DEFAULT 'probation',     -- 'active', 'probation', 'inactive', 'blacklist'
        tier TEXT DEFAULT 'C',
        
        -- 表现指标
        total_signals INTEGER DEFAULT 0,
        winning_signals INTEGER DEFAULT 0,
        losing_signals INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0,
        
        -- PnL 指标
        total_pnl REAL DEFAULT 0,
        avg_pnl REAL DEFAULT 0,
        best_pnl REAL DEFAULT 0,
        worst_pnl REAL DEFAULT 0,
        
        -- 时效性指标
        avg_time_advantage_min REAL,         -- 平均比其他源早多少分钟
        first_signal_rate REAL DEFAULT 0,    -- 作为第一信号源的比例
        
        -- 质量分数 (综合计算)
        quality_score REAL DEFAULT 50,
        
        -- 时间追踪
        first_seen_at INTEGER,
        last_signal_at INTEGER,
        last_evaluated_at INTEGER,
        probation_ends_at INTEGER,
        
        -- 元数据
        notes TEXT,
        
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        
        UNIQUE(source_type, source_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_source_status ON signal_source_performance(status);
      CREATE INDEX IF NOT EXISTS idx_source_quality ON signal_source_performance(quality_score DESC);
      CREATE INDEX IF NOT EXISTS idx_source_type_id ON signal_source_performance(source_type, source_id);
      
      -- 信号结果追踪表
      CREATE TABLE IF NOT EXISTS signal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER,
        token_ca TEXT NOT NULL,
        chain TEXT,
        
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        
        -- 入场数据
        entry_price REAL,
        entry_time INTEGER,
        
        -- 出场数据
        exit_price REAL,
        exit_time INTEGER,
        exit_reason TEXT,                    -- 'take_profit', 'stop_loss', 'manual', 'timeout'
        
        -- 结果
        pnl_percent REAL,
        pnl_absolute REAL,
        is_winner INTEGER,                   -- 1 = win, 0 = loss
        
        -- 时效性
        time_to_peak_min INTEGER,            -- 多久到达最高点
        max_gain_percent REAL,               -- 最大涨幅
        max_drawdown_percent REAL,           -- 最大回撤
        
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_outcome_source ON signal_outcomes(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_outcome_token ON signal_outcomes(token_ca);
    `);
  }

  /**
   * 记录新信号
   */
  recordSignal(sourceType, sourceId, sourceName, tokenCA, chain) {
    const now = Math.floor(Date.now() / 1000);
    
    // 更新或插入信号源
    this.db.prepare(`
      INSERT INTO signal_source_performance (
        source_type, source_id, source_name, 
        total_signals, first_seen_at, last_signal_at, 
        probation_ends_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        total_signals = total_signals + 1,
        last_signal_at = ?,
        updated_at = ?
    `).run(
      sourceType, sourceId, sourceName,
      now, now, now + this.PROBATION_DAYS * 86400, now,
      now, now
    );
    
    // 记录信号结果（待填充出场数据）
    const result = this.db.prepare(`
      INSERT INTO signal_outcomes (
        token_ca, chain, source_type, source_id, entry_time
      ) VALUES (?, ?, ?, ?, ?)
    `).run(tokenCA, chain, sourceType, sourceId, now);
    
    return result.lastInsertRowid;
  }

  /**
   * 记录信号结果
   */
  recordOutcome(signalId, exitPrice, entryPrice, exitReason, maxGain, maxDrawdown) {
    const now = Math.floor(Date.now() / 1000);
    const pnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
    const isWinner = pnlPercent > 0 ? 1 : 0;
    
    // 更新信号结果
    this.db.prepare(`
      UPDATE signal_outcomes SET
        exit_price = ?,
        exit_time = ?,
        exit_reason = ?,
        pnl_percent = ?,
        is_winner = ?,
        max_gain_percent = ?,
        max_drawdown_percent = ?
      WHERE id = ?
    `).run(exitPrice, now, exitReason, pnlPercent, isWinner, maxGain, maxDrawdown, signalId);
    
    // 获取信号源信息
    const signal = this.db.prepare(`
      SELECT source_type, source_id FROM signal_outcomes WHERE id = ?
    `).get(signalId);
    
    if (signal) {
      // 更新信号源表现
      this.updateSourcePerformance(signal.source_type, signal.source_id);
    }
  }

  /**
   * 更新信号源表现指标
   */
  updateSourcePerformance(sourceType, sourceId) {
    const now = Math.floor(Date.now() / 1000);
    
    // 计算表现指标
    const stats = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_winner = 1 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN is_winner = 0 THEN 1 ELSE 0 END) as losses,
        AVG(pnl_percent) as avg_pnl,
        SUM(pnl_percent) as total_pnl,
        MAX(pnl_percent) as best_pnl,
        MIN(pnl_percent) as worst_pnl
      FROM signal_outcomes 
      WHERE source_type = ? AND source_id = ? AND exit_time IS NOT NULL
    `).get(sourceType, sourceId);
    
    if (!stats || stats.total === 0) return;
    
    const winRate = stats.total > 0 ? stats.wins / stats.total : 0;
    
    // 计算质量分数
    const qualityScore = this.calculateQualityScore({
      winRate,
      avgPnl: stats.avg_pnl || 0,
      totalSignals: stats.total,
      bestPnl: stats.best_pnl || 0,
      worstPnl: stats.worst_pnl || 0
    });
    
    // 更新数据库
    this.db.prepare(`
      UPDATE signal_source_performance SET
        winning_signals = ?,
        losing_signals = ?,
        win_rate = ?,
        total_pnl = ?,
        avg_pnl = ?,
        best_pnl = ?,
        worst_pnl = ?,
        quality_score = ?,
        last_evaluated_at = ?,
        updated_at = ?
      WHERE source_type = ? AND source_id = ?
    `).run(
      stats.wins, stats.losses, winRate,
      stats.total_pnl, stats.avg_pnl, stats.best_pnl, stats.worst_pnl,
      qualityScore, now, now,
      sourceType, sourceId
    );
  }

  /**
   * 计算质量分数 (0-100)
   */
  calculateQualityScore(metrics) {
    let score = 50; // 基础分
    
    // 胜率贡献 (0-30 分)
    // 50% 胜率 = 15分，70% = 25分，30% = 5分
    score += (metrics.winRate - 0.3) * 75;
    
    // 平均收益贡献 (0-30 分)
    // 10% 平均收益 = 15分，50% = 30分，-20% = 0分
    score += Math.min(30, Math.max(0, (metrics.avgPnl + 20) * 0.5));
    
    // 样本量贡献 (0-20 分)
    // 更多信号 = 更可靠的评估
    score += Math.min(20, metrics.totalSignals * 2);
    
    // 最大回撤惩罚
    if (metrics.worstPnl < -50) {
      score -= 10; // 有过大亏损
    }
    
    // 最佳表现奖励
    if (metrics.bestPnl > 100) {
      score += 10; // 有过大赢家
    }
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * 每日评估：更新所有信号源表现
   */
  dailyEvaluation() {
    console.log('📊 [Optimizer] Running daily evaluation...');
    
    const sources = this.db.prepare(`
      SELECT source_type, source_id FROM signal_source_performance
      WHERE status IN ('active', 'probation')
    `).all();
    
    for (const source of sources) {
      this.updateSourcePerformance(source.source_type, source.source_id);
    }
    
    console.log(`   ✅ Evaluated ${sources.length} signal sources`);
  }

  /**
   * 每周优化：淘汰差源，保持 TOP N
   */
  weeklyOptimization() {
    console.log('🔄 [Optimizer] Running weekly optimization...');
    const now = Math.floor(Date.now() / 1000);
    
    // 1. 结束观察期的源 - 评估是否转正或淘汰
    const probationEnded = this.db.prepare(`
      SELECT * FROM signal_source_performance
      WHERE status = 'probation' AND probation_ends_at <= ?
    `).all(now);
    
    let promoted = 0, demoted = 0;
    
    for (const source of probationEnded) {
      if (source.total_signals >= this.MIN_SIGNALS_FOR_EVAL) {
        if (source.win_rate >= this.MIN_WIN_RATE && source.avg_pnl >= this.MIN_AVG_PNL) {
          // 表现好，转正
          this.db.prepare(`
            UPDATE signal_source_performance SET status = 'active', updated_at = ?
            WHERE id = ?
          `).run(now, source.id);
          promoted++;
        } else {
          // 表现差，淘汰
          this.db.prepare(`
            UPDATE signal_source_performance SET status = 'inactive', updated_at = ?
            WHERE id = ?
          `).run(now, source.id);
          demoted++;
        }
      } else {
        // 信号太少，延长观察期
        this.db.prepare(`
          UPDATE signal_source_performance SET 
            probation_ends_at = probation_ends_at + ?,
            updated_at = ?
          WHERE id = ?
        `).run(this.PROBATION_DAYS * 86400, now, source.id);
      }
    }
    
    console.log(`   📈 Probation results: ${promoted} promoted, ${demoted} demoted`);
    
    // 2. 淘汰表现差的活跃源
    const poorPerformers = this.db.prepare(`
      SELECT * FROM signal_source_performance
      WHERE status = 'active' 
        AND total_signals >= ?
        AND (win_rate < ? OR avg_pnl < ?)
    `).all(this.MIN_SIGNALS_FOR_EVAL, this.MIN_WIN_RATE * 0.8, this.MIN_AVG_PNL * 2);
    
    for (const source of poorPerformers) {
      this.db.prepare(`
        UPDATE signal_source_performance SET status = 'inactive', updated_at = ?
        WHERE id = ?
      `).run(now, source.id);
    }
    
    if (poorPerformers.length > 0) {
      console.log(`   ❌ Deactivated ${poorPerformers.length} poor performers`);
    }
    
    // 3. 保持 TOP N 活跃源
    const activeCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM signal_source_performance WHERE status = 'active'
    `).get().count;
    
    if (activeCount > this.MAX_ACTIVE_SOURCES) {
      // 按质量分数排序，淘汰末尾的
      const toDeactivate = activeCount - this.MAX_ACTIVE_SOURCES;
      this.db.prepare(`
        UPDATE signal_source_performance SET status = 'inactive', updated_at = ?
        WHERE id IN (
          SELECT id FROM signal_source_performance 
          WHERE status = 'active'
          ORDER BY quality_score ASC
          LIMIT ?
        )
      `).run(now, toDeactivate);
      
      console.log(`   ⚖️ Trimmed to top ${this.MAX_ACTIVE_SOURCES}: deactivated ${toDeactivate} lowest quality`);
    }
    
    // 4. 输出当前 TOP 源
    const topSources = this.getTopSources();
    console.log(`\n   🏆 Current TOP ${topSources.length} Active Sources:`);
    for (let i = 0; i < topSources.length; i++) {
      const s = topSources[i];
      console.log(`      ${i + 1}. ${s.source_id} - Score: ${s.quality_score.toFixed(0)}, WinRate: ${(s.win_rate * 100).toFixed(0)}%, AvgPnL: ${s.avg_pnl?.toFixed(1) || 0}%`);
    }
  }

  /**
   * 获取 TOP N 活跃信号源
   */
  getTopSources(limit = null) {
    const actualLimit = limit || this.MAX_ACTIVE_SOURCES;
    return this.db.prepare(`
      SELECT * FROM signal_source_performance
      WHERE status = 'active'
      ORDER BY quality_score DESC
      LIMIT ?
    `).all(actualLimit);
  }

  /**
   * 获取信号源质量分数（用于评分调整）
   */
  getSourceQuality(sourceType, sourceId) {
    const source = this.db.prepare(`
      SELECT quality_score, win_rate, avg_pnl, status, tier
      FROM signal_source_performance
      WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    
    if (!source) {
      return { quality: 50, tier: 'C', isActive: false };
    }
    
    return {
      quality: source.quality_score,
      winRate: source.win_rate,
      avgPnl: source.avg_pnl,
      tier: source.tier,
      isActive: source.status === 'active'
    };
  }

  /**
   * 检查信号源是否应该被使用
   */
  shouldUseSource(sourceType, sourceId) {
    const source = this.db.prepare(`
      SELECT status FROM signal_source_performance
      WHERE source_type = ? AND source_id = ?
    `).get(sourceType, sourceId);
    
    // 新源默认使用（观察期）
    if (!source) return true;
    
    // 只使用 active 或 probation 状态的源
    return source.status === 'active' || source.status === 'probation';
  }

  /**
   * 获取统计摘要
   */
  getStats() {
    const stats = this.db.prepare(`
      SELECT 
        status,
        COUNT(*) as count,
        AVG(quality_score) as avg_quality,
        AVG(win_rate) as avg_win_rate,
        AVG(avg_pnl) as avg_pnl
      FROM signal_source_performance
      GROUP BY status
    `).all();
    
    const total = this.db.prepare(`
      SELECT 
        COUNT(*) as total_sources,
        SUM(total_signals) as total_signals,
        SUM(winning_signals) as total_wins,
        SUM(losing_signals) as total_losses
      FROM signal_source_performance
    `).get();
    
    return { byStatus: stats, totals: total };
  }

  /**
   * 添加新信号源到观察列表
   */
  addSource(sourceType, sourceId, sourceName, tier = 'C') {
    const now = Math.floor(Date.now() / 1000);
    
    this.db.prepare(`
      INSERT OR IGNORE INTO signal_source_performance (
        source_type, source_id, source_name, tier,
        status, first_seen_at, probation_ends_at, updated_at
      ) VALUES (?, ?, ?, ?, 'probation', ?, ?, ?)
    `).run(
      sourceType, sourceId, sourceName, tier,
      now, now + this.PROBATION_DAYS * 86400, now
    );
  }

  /**
   * 手动拉黑信号源
   */
  blacklistSource(sourceType, sourceId, reason) {
    const now = Math.floor(Date.now() / 1000);
    
    this.db.prepare(`
      UPDATE signal_source_performance SET 
        status = 'blacklist',
        notes = ?,
        updated_at = ?
      WHERE source_type = ? AND source_id = ?
    `).run(reason, now, sourceType, sourceId);
  }
}

export default SignalSourceOptimizer;
