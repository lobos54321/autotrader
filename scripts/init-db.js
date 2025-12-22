#!/usr/bin/env node
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Use DB_PATH from env, or fallback to ./data
const dbPath = process.env.DB_PATH || join(projectRoot, 'data', 'sentiment_arb.db');
const dataDir = dirname(dbPath);

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

console.log('🗄️  Initializing database schema...');

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Table 1: tokens
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token_ca TEXT PRIMARY KEY,
    chain TEXT NOT NULL CHECK(chain IN ('SOL', 'BSC')),
    symbol TEXT,
    name TEXT,
    first_seen_at INTEGER NOT NULL,
    mc_at_signal REAL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain);
  CREATE INDEX IF NOT EXISTS idx_tokens_first_seen ON tokens(first_seen_at);
`);

// Table 2: gates
db.exec(`
  CREATE TABLE IF NOT EXISTS gates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_ca TEXT NOT NULL,
    evaluated_at INTEGER NOT NULL,

    -- Hard Gate
    hard_status TEXT NOT NULL CHECK(hard_status IN ('PASS', 'GREYLIST', 'REJECT')),
    hard_reasons TEXT, -- JSON array

    -- Hard Gate SOL fields
    freeze_authority TEXT,
    mint_authority TEXT,
    lp_status TEXT,

    -- Hard Gate BSC fields
    honeypot TEXT,
    tax_buy REAL,
    tax_sell REAL,
    tax_mutable INTEGER,
    owner_type TEXT,
    dangerous_functions TEXT, -- JSON array

    -- Exit Gate
    exit_status TEXT NOT NULL CHECK(exit_status IN ('PASS', 'GREYLIST', 'REJECT')),
    exit_reasons TEXT, -- JSON array

    top10_percent REAL,
    liquidity REAL,
    liquidity_unit TEXT, -- SOL/BNB/USD
    slippage_sell_20pct REAL,
    wash_flag TEXT CHECK(wash_flag IN ('LOW', 'MEDIUM', 'HIGH')),
    key_risk_wallets TEXT, -- JSON array

    -- BSC specific
    vol_24h_usd REAL,
    sell_constraints_flag INTEGER,

    FOREIGN KEY (token_ca) REFERENCES tokens(token_ca)
  );
  CREATE INDEX IF NOT EXISTS idx_gates_token ON gates(token_ca);
  CREATE INDEX IF NOT EXISTS idx_gates_evaluated ON gates(evaluated_at);
  CREATE INDEX IF NOT EXISTS idx_gates_status ON gates(hard_status, exit_status);
`);

// Table 3: social_snapshots
db.exec(`
  CREATE TABLE IF NOT EXISTS social_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_ca TEXT NOT NULL,
    observed_at INTEGER NOT NULL,

    -- TG data
    promoted_channels TEXT, -- JSON array of {name, tme_link, timestamp, tier}
    tg_t0 INTEGER, -- earliest mention timestamp
    tg_time_lag INTEGER, -- minutes from t0 to now
    tg_ch_5m INTEGER,
    tg_ch_15m INTEGER,
    tg_ch_60m INTEGER,
    tg_velocity REAL,
    tg_accel REAL,
    tg_clusters_15m INTEGER,
    N_total INTEGER,

    -- X data
    x_first_mention_time INTEGER,
    x_unique_authors_15m INTEGER,
    x_tier1_hit INTEGER DEFAULT 0,

    FOREIGN KEY (token_ca) REFERENCES tokens(token_ca)
  );
  CREATE INDEX IF NOT EXISTS idx_social_token ON social_snapshots(token_ca);
  CREATE INDEX IF NOT EXISTS idx_social_observed ON social_snapshots(observed_at);
`);

// Table 4: trades
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_ca TEXT NOT NULL,
    chain TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    narrative TEXT,

    -- Decision context
    rating TEXT,
    action TEXT,
    position_tier TEXT CHECK(position_tier IN ('small', 'medium', 'large', 'Small', 'Normal', 'Max')),
    position_size REAL,

    -- Entry execution
    executed_price REAL,
    tokens_received REAL,
    actual_slippage REAL,
    tx_hash TEXT,
    timestamp INTEGER,

    -- Status
    status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED', 'PARTIAL')),
    is_simulation INTEGER DEFAULT 0,

    -- Exit data
    exit_timestamp INTEGER,
    exit_tx_hash TEXT,
    exit_reason TEXT,
    exit_price REAL,
    realized_pnl REAL,

    -- Performance metrics (for analysis)
    max_up_2h REAL,
    max_dd_2h REAL,
    hold_duration_minutes INTEGER,

    -- Risk flags
    rug_flag INTEGER DEFAULT 0,
    cannot_exit_flag INTEGER DEFAULT 0,

    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),

    FOREIGN KEY (token_ca) REFERENCES tokens(token_ca)
  );
  CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_ca);
  CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
  CREATE INDEX IF NOT EXISTS idx_trades_chain ON trades(chain);
  CREATE INDEX IF NOT EXISTS idx_trades_rating ON trades(rating);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
`);

// Table 5: score_details (for debugging and optimization)
db.exec(`
  CREATE TABLE IF NOT EXISTS score_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_ca TEXT NOT NULL,
    calculated_at INTEGER NOT NULL,

    -- Component scores
    narrative_score REAL,
    narrative_reasons TEXT,

    influence_score REAL,
    influence_reasons TEXT,

    tg_spread_score REAL,
    tg_spread_reasons TEXT,

    graph_score REAL,
    graph_reasons TEXT,

    source_score REAL,
    source_reasons TEXT,

    -- Adjustments
    matrix_penalty REAL DEFAULT 0,
    x_validation_multiplier REAL DEFAULT 1.0,

    -- Final
    total_score REAL NOT NULL,

    FOREIGN KEY (token_ca) REFERENCES tokens(token_ca)
  );
  CREATE INDEX IF NOT EXISTS idx_score_token ON score_details(token_ca);
  CREATE INDEX IF NOT EXISTS idx_score_calculated ON score_details(calculated_at);
`);

// Table 6: channel_performance (for weekly optimization)
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_performance (
    tme_link TEXT PRIMARY KEY,
    channel_name TEXT,
    current_tier TEXT,

    -- Performance metrics (30-120min window)
    total_signals INTEGER DEFAULT 0,
    avg_pnl_30_120 REAL DEFAULT 0,
    win_rate_30_120 REAL DEFAULT 0,
    reject_ratio_24h REAL DEFAULT 0,

    -- Lead time analysis
    avg_lead_time_minutes REAL,
    is_upstream INTEGER DEFAULT 0,

    -- Matrix detection
    matrix_flags INTEGER DEFAULT 0,
    last_matrix_detected INTEGER,

    -- Status
    status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'WATCH', 'BLOCKED')),

    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_channel_tier ON channel_performance(current_tier);
  CREATE INDEX IF NOT EXISTS idx_channel_status ON channel_performance(status);
`);

// Table 7: system_state (for cooldowns and global state)
db.exec(`
  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    expires_at INTEGER,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_state_expires ON system_state(expires_at);
`);

// Table 8: backtest_runs (for shadow mode and backtesting)
db.exec(`
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_name TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,

    config_snapshot TEXT, -- JSON of config used

    -- Summary stats
    total_signals INTEGER DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    win_rate REAL,
    avg_pnl REAL,
    total_pnl REAL,
    max_drawdown REAL,
    sharpe_ratio REAL,

    mode TEXT CHECK(mode IN ('SHADOW', 'BACKTEST', 'LIVE')),

    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
`);

// Table 9: telegram_signals (stores raw signals from TG channels)
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_name TEXT NOT NULL,
    channel_username TEXT,
    message_text TEXT,
    token_ca TEXT NOT NULL,
    chain TEXT NOT NULL CHECK(chain IN ('SOL', 'BSC')),
    timestamp TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signals_token ON telegram_signals(token_ca);
  CREATE INDEX IF NOT EXISTS idx_signals_processed ON telegram_signals(processed);
  CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON telegram_signals(timestamp);
  CREATE INDEX IF NOT EXISTS idx_signals_channel ON telegram_signals(channel_name);
`);

// Table 10: telegram_channels (monitored channels list)
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_name TEXT NOT NULL,
    channel_username TEXT UNIQUE,
    tier TEXT DEFAULT 'C' CHECK(tier IN ('A', 'B', 'C', 'BLACKLIST')),
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_channels_active ON telegram_channels(active);
  CREATE INDEX IF NOT EXISTS idx_channels_tier ON telegram_channels(tier);
`);

// Table 11: positions (active and closed positions for monitoring)
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL CHECK(chain IN ('SOL', 'BSC')),
    token_ca TEXT NOT NULL,
    symbol TEXT,
    signal_id INTEGER,

    -- Entry data
    entry_time TEXT NOT NULL,
    entry_price REAL,
    position_size_native REAL,
    position_size_usd REAL,

    -- Scoring context
    alpha_score REAL,
    confidence REAL,
    kelly_fraction REAL,

    -- Entry snapshot
    entry_liquidity_usd REAL,
    entry_top10_holders REAL,
    entry_slippage_bps REAL,
    entry_tg_accel REAL,
    entry_risk_wallets TEXT, -- JSON array

    -- Exit data
    exit_time TEXT,
    exit_price REAL,
    exit_type TEXT,
    pnl_percent REAL,
    pnl_native REAL,
    pnl_usd REAL,

    -- Partial exits
    partial_exit_1 INTEGER DEFAULT 0,
    partial_exit_1_time TEXT,
    partial_exit_1_price REAL,
    remaining_percent REAL DEFAULT 100,

    -- Execution
    trade_id INTEGER,
    entry_tx_hash TEXT,
    exit_tx_hash TEXT,

    -- Status
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'partial')),

    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),

    FOREIGN KEY (signal_id) REFERENCES telegram_signals(id)
  );
  CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
  CREATE INDEX IF NOT EXISTS idx_positions_chain ON positions(chain);
  CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_ca);
`);

// Table 11: scout_positions (引擎 A - 聪明钱触发的仓位)
db.exec(`
  CREATE TABLE IF NOT EXISTS scout_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_ca TEXT NOT NULL,
    chain TEXT NOT NULL,
    entry_price REAL,
    position_size REAL,
    smart_wallet TEXT,
    smart_money_amount REAL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'shadow', 'closed', 'failed')),
    confirmed INTEGER DEFAULT 0,
    confirmed_at TEXT,
    exit_price REAL,
    exit_time TEXT,
    pnl_percent REAL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scout_token ON scout_positions(token_ca);
  CREATE INDEX IF NOT EXISTS idx_scout_status ON scout_positions(status);
`);

console.log('✅ Database schema created successfully');
console.log(`📍 Database location: ${dbPath}`);

// Insert initial channel data from CSV
console.log('📊 Loading initial channel data...');

const channelsCSV = fs.readFileSync(join(projectRoot, 'config', 'channels.csv'), 'utf-8');
const lines = channelsCSV.split('\n').slice(1); // Skip header

const insertChannel = db.prepare(`
  INSERT OR REPLACE INTO channel_performance (
    tme_link, channel_name, current_tier, avg_pnl_30_120, reject_ratio_24h, status
  ) VALUES (?, ?, ?, ?, ?, ?)
`);

// Also insert into telegram_channels for monitoring
const insertTelegramChannel = db.prepare(`
  INSERT OR REPLACE INTO telegram_channels (
    channel_name, channel_username, tier, active
  ) VALUES (?, ?, ?, ?)
`);

let channelCount = 0;
for (const line of lines) {
  // Skip empty lines and comments
  if (!line.trim() || line.trim().startsWith('#')) continue;

  const [name, link, tier, status, ev, reject] = line.split(',').map(s => s.trim());

  // Insert into channel_performance
  insertChannel.run(
    link,
    name,
    tier,
    parseFloat(ev) || 0,
    parseFloat(reject) || 0,
    status
  );

  // Insert into telegram_channels (only ACTIVE channels, not BLOCKED)
  if (status === 'ACTIVE' || status === 'WATCH') {
    // Convert t.me/channelname to @channelname format
    const username = '@' + link.replace('t.me/', '');
    const isActive = status === 'ACTIVE' ? 1 : 0;
    
    insertTelegramChannel.run(
      name,
      username,
      tier,
      isActive
    );
  }
  channelCount++;
}

console.log(`✅ Loaded ${channelCount} channels`);

db.close();

console.log('\n🎉 Database initialization complete!');
console.log('Next steps:');
console.log('  1. npm install');
console.log('  2. cp .env.example .env (and fill in your keys)');
console.log('  3. npm run shadow (to start in shadow mode)');
