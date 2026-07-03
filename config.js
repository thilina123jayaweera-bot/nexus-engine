// config.js — engine configuration. All risk/behaviour knobs live here (ported
// from the browser RULES/PORTFOLIO), plus runtime/safety flags read from env.
module.exports = {
  // ── SAFETY (default to the safe state) ─────────────────────────────
  DRY_RUN:     process.env.DRY_RUN !== 'false',   // true = log intended orders, place NOTHING
  TESTNET:     process.env.TESTNET !== 'false',   // true = Binance futures testnet
  AUTO_MODE:   process.env.AUTO_MODE === 'true',  // must be explicitly enabled
  // ── credentials (server-side only; never sent to the browser) ───────
  API_KEY:     process.env.BINANCE_KEY || '',
  API_SECRET:  process.env.BINANCE_SECRET || '',
  // ── capital / universe ──────────────────────────────────────────────
  CAPITAL:     +(process.env.CAPITAL || 500),
  MAX_POS:     +(process.env.MAX_POS || 3),
  LEVERAGE:    +(process.env.LEVERAGE || 3),
  STOP_LOSS:   +(process.env.STOP_LOSS || 2),     // % price
  ALLOW_SHORTS: process.env.ALLOW_SHORTS !== 'false',
  UNIVERSE_SIZE: +(process.env.UNIVERSE_SIZE || 50),
  EVAL_INTERVAL_MS: 5*60*1000,                    // full scan + entry cadence
  TICK_MS: 5*1000,                                // exit-management cadence
  // ── ported RULES (subset — extend toward full parity over time) ─────
  RULES:{
    MIN_PROFIT_SCORE:72, MIN_RR:2.0, MIN_CONVICTION:18,
    FULL_TARGET_MULTI:4.0, PARTIAL_TAKE_PCT:1.2, PARTIAL_TAKE_FRAC:0.40,
    TRAIL_START_PCT:0.5, TRAIL_LOCK:0.70, SCORE_DROP_EXIT:15, ROTATE_ADVANTAGE:18,
    MAX_HOLD_MINUTES:480, KELLY_FRACTION:0.25, MAX_STOP_ROI:25,
    WIN_STREAK_LEV_BOOST:1.20, LOSS_STREAK_LEV_CUT:0.60, MAX_CORRELATED_POS:2,
    REGIME_SIZE:{CALM:1.15,ELEVATED:0.65,EXTREME:0.35},
    SMALLCAP_MAX_ALLOC_FRAC:0.5, SMALLCAP_LEV_CAP:5,
    REENTRY_COOLDOWN_MIN:15, LOCK_COOLDOWN_MIN:60,
    SOFT_THRESHOLD:true, SOFT_MISS_HAIRCUT:0.70, SOFT_MISS_MAX:1,
    SOFT_SCORE_BONUS:6, SOFT_BAND_BUBBLE:8, SOFT_BAND_RSI:6,
    WEIGHTS:{deriv:40,chain:30,senti:20,tech:10},
  },
  PORTFOLIO_DEFAULTS:{ maxLossPct:0.20, profitLockPct:0.80, riskPerTradePct:0.01 },
  STATE_FILE: process.env.STATE_FILE || './engine-state.json',
};
