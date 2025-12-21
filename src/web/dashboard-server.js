/**
 * Web Dashboard Server
 * 
 * 提供系统状态、信号源排名、虚拟仓位表现的 Web 界面
 */

import http from 'http';
import { URL } from 'url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const dbPath = process.env.DB_PATH || './data/sentiment_arb.db';

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error('❌ Failed to open database:', e.message);
}

/**
 * HTML 模板
 */
function renderDashboard(data) {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentiment Arbitrage Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e4e4e4;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { 
      text-align: center; 
      margin-bottom: 30px; 
      color: #00d9ff;
      font-size: 2.5em;
      text-shadow: 0 0 20px rgba(0, 217, 255, 0.3);
    }
    .grid { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
      gap: 20px; 
      margin-bottom: 30px;
    }
    .card {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 15px;
      padding: 20px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
    }
    .card h2 {
      color: #00d9ff;
      margin-bottom: 15px;
      font-size: 1.2em;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
    }
    .stat {
      background: rgba(0, 0, 0, 0.2);
      padding: 15px;
      border-radius: 10px;
      text-align: center;
    }
    .stat-value {
      font-size: 2em;
      font-weight: bold;
      color: #00ff88;
    }
    .stat-value.negative { color: #ff4757; }
    .stat-value.neutral { color: #ffa502; }
    .stat-label { color: #888; font-size: 0.9em; margin-top: 5px; }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    th, td {
      padding: 12px 8px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    th { color: #00d9ff; font-weight: 600; }
    tr:hover { background: rgba(255, 255, 255, 0.05); }
    
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.8em;
      font-weight: 600;
    }
    .badge-green { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
    .badge-yellow { background: rgba(255, 165, 2, 0.2); color: #ffa502; }
    .badge-red { background: rgba(255, 71, 87, 0.2); color: #ff4757; }
    
    .exit-strategy {
      background: rgba(0, 217, 255, 0.1);
      border-radius: 10px;
      padding: 15px;
      margin-top: 10px;
    }
    .exit-strategy h3 { color: #00d9ff; margin-bottom: 10px; }
    .exit-rule {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .exit-rule:last-child { border-bottom: none; }
    
    .refresh-info {
      text-align: center;
      color: #666;
      margin-top: 20px;
      font-size: 0.9em;
    }
    
    .pnl-positive { color: #00ff88; }
    .pnl-negative { color: #ff4757; }
    
    .token-address {
      font-family: monospace;
      font-size: 0.85em;
      color: #888;
    }
  </style>
  <meta http-equiv="refresh" content="60">
</head>
<body>
  <div class="container">
    <h1>🤖 Sentiment Arbitrage Dashboard</h1>
    
    <!-- 系统概览 -->
    <div class="grid">
      <div class="card">
        <h2>📊 系统状态</h2>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-value">${data.overview.mode}</div>
            <div class="stat-label">运行模式</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.overview.channels}</div>
            <div class="stat-label">监控频道</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.overview.signals_today}</div>
            <div class="stat-label">今日信号</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.overview.positions_open}</div>
            <div class="stat-label">持仓数量</div>
          </div>
        </div>
      </div>
      
      <div class="card">
        <h2>💰 虚拟收益统计</h2>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-value ${data.performance.total_pnl >= 0 ? '' : 'negative'}">${data.performance.total_pnl >= 0 ? '+' : ''}${data.performance.total_pnl.toFixed(1)}%</div>
            <div class="stat-label">总收益率</div>
          </div>
          <div class="stat">
            <div class="stat-value ${data.performance.win_rate >= 50 ? '' : 'neutral'}">${data.performance.win_rate.toFixed(1)}%</div>
            <div class="stat-label">胜率</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.performance.total_trades}</div>
            <div class="stat-label">总交易数</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.performance.avg_pnl >= 0 ? '+' : ''}${data.performance.avg_pnl.toFixed(2)}%</div>
            <div class="stat-label">平均收益</div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 信号源排名 -->
    <div class="card" style="margin-bottom: 20px;">
      <h2>🏆 信号源排名 (按胜率)</h2>
      <table>
        <thead>
          <tr>
            <th>排名</th>
            <th>信号源</th>
            <th>信号数</th>
            <th>胜率</th>
            <th>平均收益</th>
            <th>最佳</th>
            <th>最差</th>
          </tr>
        </thead>
        <tbody>
          ${data.sources.map((s, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${s.source_id || 'Unknown'}</td>
              <td>${s.total_signals}</td>
              <td><span class="badge ${s.win_rate >= 50 ? 'badge-green' : s.win_rate >= 30 ? 'badge-yellow' : 'badge-red'}">${s.win_rate.toFixed(1)}%</span></td>
              <td class="${s.avg_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">${s.avg_pnl >= 0 ? '+' : ''}${s.avg_pnl.toFixed(2)}%</td>
              <td class="pnl-positive">+${(s.best_pnl || 0).toFixed(1)}%</td>
              <td class="pnl-negative">${(s.worst_pnl || 0).toFixed(1)}%</td>
            </tr>
          `).join('')}
          ${data.sources.length === 0 ? '<tr><td colspan="7" style="text-align:center;color:#666;">暂无数据，系统运行中...</td></tr>' : ''}
        </tbody>
      </table>
    </div>
    
    <!-- 虚拟仓位 -->
    <div class="card" style="margin-bottom: 20px;">
      <h2>📈 虚拟仓位表现</h2>
      <table>
        <thead>
          <tr>
            <th>代币</th>
            <th>链</th>
            <th>入场价</th>
            <th>当前价/退出价</th>
            <th>收益率</th>
            <th>Alpha分</th>
            <th>状态</th>
            <th>持仓时间</th>
          </tr>
        </thead>
        <tbody>
          ${data.positions.map(p => `
            <tr>
              <td>
                <div>${p.symbol || 'Unknown'}</div>
                <div class="token-address">${p.token_ca?.substring(0, 8)}...</div>
              </td>
              <td><span class="badge ${p.chain === 'SOL' ? 'badge-green' : 'badge-yellow'}">${p.chain}</span></td>
              <td>$${p.entry_price?.toFixed(10) || 'N/A'}</td>
              <td>$${(p.exit_price || p.current_price)?.toFixed(10) || 'N/A'}</td>
              <td class="${(p.pnl_percent || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">
                ${(p.pnl_percent || 0) >= 0 ? '+' : ''}${(p.pnl_percent || 0).toFixed(2)}%
              </td>
              <td>${(p.alpha_score || 0).toFixed(0)}</td>
              <td><span class="badge ${p.status === 'open' ? 'badge-yellow' : p.pnl_percent >= 0 ? 'badge-green' : 'badge-red'}">${p.status}</span></td>
              <td>${p.hold_time || 'N/A'}</td>
            </tr>
          `).join('')}
          ${data.positions.length === 0 ? '<tr><td colspan="8" style="text-align:center;color:#666;">暂无仓位</td></tr>' : ''}
        </tbody>
      </table>
    </div>
    
    <!-- 止盈止损策略 -->
    <div class="card">
      <h2>⚙️ 止盈止损策略</h2>
      <div class="grid" style="grid-template-columns: repeat(3, 1fr);">
        <div class="exit-strategy">
          <h3>🚨 Tier 1: 风险退出</h3>
          <div class="exit-rule"><span>关键钱包抛售</span><span>>30%</span></div>
          <div class="exit-rule"><span>Top10集中度增加</span><span>>15%</span></div>
          <div class="exit-rule"><span>滑点恶化</span><span>>3x</span></div>
        </div>
        <div class="exit-strategy">
          <h3>📉 Tier 2: 情绪衰退</h3>
          <div class="exit-rule"><span>TG加速度衰减</span><span><50%</span></div>
          <div class="exit-rule"><span>TG加速度负值</span><span><-10</span></div>
        </div>
        <div class="exit-strategy">
          <h3>📊 Tier 3: 标准SOP</h3>
          <div class="exit-rule"><span>止损</span><span class="pnl-negative">-20%</span></div>
          <div class="exit-rule"><span>止盈1 (卖50%)</span><span class="pnl-positive">+30%</span></div>
          <div class="exit-rule"><span>止盈2 (卖全部)</span><span class="pnl-positive">+50%</span></div>
          <div class="exit-rule"><span>最大持仓时间</span><span>3小时</span></div>
        </div>
      </div>
    </div>
    
    <div class="refresh-info">
      页面每60秒自动刷新 | 最后更新: ${new Date().toLocaleString('zh-CN')}
    </div>
  </div>
</body>
</html>
`;
}

/**
 * 获取仪表盘数据
 */
function getDashboardData() {
  const data = {
    overview: {
      mode: 'SHADOW',
      channels: 0,
      signals_today: 0,
      positions_open: 0
    },
    performance: {
      total_pnl: 0,
      win_rate: 0,
      total_trades: 0,
      avg_pnl: 0
    },
    sources: [],
    positions: []
  };

  if (!db) return data;

  try {
    // 系统概览
    const channels = db.prepare(`SELECT COUNT(*) as c FROM telegram_channels WHERE active = 1`).get();
    data.overview.channels = channels?.c || 0;

    const signalsToday = db.prepare(`
      SELECT COUNT(*) as c FROM telegram_signals 
      WHERE created_at > strftime('%s', 'now', '-1 day')
    `).get();
    data.overview.signals_today = signalsToday?.c || 0;

    const openPositions = db.prepare(`SELECT COUNT(*) as c FROM positions WHERE status = 'open'`).get();
    data.overview.positions_open = openPositions?.c || 0;

    // 虚拟收益统计
    const perfStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
        AVG(pnl_percent) as avg_pnl,
        SUM(pnl_percent) as total_pnl
      FROM positions 
      WHERE status = 'closed'
    `).get();

    if (perfStats && perfStats.total > 0) {
      data.performance.total_trades = perfStats.total;
      data.performance.win_rate = (perfStats.wins / perfStats.total) * 100;
      data.performance.avg_pnl = perfStats.avg_pnl || 0;
      data.performance.total_pnl = perfStats.total_pnl || 0;
    }

    // 信号源排名 (从 shadow_price_tracking 或 positions)
    try {
      const sources = db.prepare(`
        SELECT 
          source_id,
          COUNT(*) as total_signals,
          ROUND(AVG(pnl_15m), 2) as avg_pnl,
          ROUND(MAX(max_pnl), 2) as best_pnl,
          ROUND(MIN(CASE WHEN pnl_15m < 0 THEN pnl_15m END), 2) as worst_pnl,
          ROUND(SUM(CASE WHEN pnl_15m > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate
        FROM shadow_price_tracking
        WHERE status = 'completed' AND source_id IS NOT NULL
        GROUP BY source_id
        HAVING total_signals >= 2
        ORDER BY win_rate DESC
        LIMIT 15
      `).all();
      data.sources = sources || [];
    } catch (e) {
      // 表可能不存在
    }

    // 虚拟仓位
    const positions = db.prepare(`
      SELECT 
        p.*,
        CASE 
          WHEN p.status = 'open' THEN 
            ROUND((julianday('now') - julianday(p.entry_time)) * 24 * 60) || ' min'
          ELSE 
            ROUND((julianday(p.exit_time) - julianday(p.entry_time)) * 24 * 60) || ' min'
        END as hold_time
      FROM positions p
      ORDER BY p.created_at DESC
      LIMIT 20
    `).all();
    data.positions = positions || [];

  } catch (error) {
    console.error('❌ Get dashboard data error:', error.message);
  }

  return data;
}

/**
 * HTTP 服务器
 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/' || url.pathname === '/dashboard') {
    const data = getDashboardData();
    const html = renderDashboard(data);
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (url.pathname === '/api/status') {
    const data = getDashboardData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  } else if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

/**
 * 启动服务器
 */
export function startDashboardServer() {
  server.listen(PORT, () => {
    console.log(`🌐 Dashboard server running at http://localhost:${PORT}`);
  });
  return server;
}

// 直接运行时启动服务器
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboardServer();
}

export default { startDashboardServer };
