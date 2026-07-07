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
    // Momentum-rollover give-back exit (asymmetric decay) — bank a thin margin when a
    // once-profitable trade rolls over, instead of riding to the stop.
    GIVEBACK_MIN_PEAK_ROI:4,    // arm only after peak ROI ≥ this %
    GIVEBACK_PEAK_HIGH_ROI:20,  // peak treated as "high momentum" (gets wide breathing room)
    GIVEBACK_TIGHT:0.70,        // small peaks: exit if ROI falls below 70% of peak (gave back 30%)
    GIVEBACK_WIDE:0.35,         // big peaks: allow fall to 35% of peak (gave back 65%)
    STREAK_DEADBAND_ROI:1.5,    // a loss smaller than this ROI% is a scratch — doesn't build the streak
    // Spike take — bank a sharp ROI spike immediately, before it mean-reverts
    // (speed beats confirmation at the extremes; no momentum check required).
    SPIKE_ROI:12,               // ROI% that triggers an unconditional take
    FAST_SPIKE_ROI:8,           // ROI% gained within the window below → immediate take (pop-and-fade)
    FAST_SPIKE_WIN_MS:240000,   // 4-min velocity window for the fast-spike check
    // Shorts — let a clearly over-extended token short even in a fear regime
    // (crowded-long funding + overbought + high bubble), overriding the market-wide tilt.
    SHORT_OVEREXT_BOOST:8,      // per over-extension flag added to the short score
    SHORT_SIZE_HAIRCUT:0.7,     // shorts sized smaller (lower-conviction until Coinglass adds OI/liq)
    // Pyramiding — add ONE capped tranche to a strong, still-rising winner ("add to
    // what works"). Never adds after a rollover; raises the stop to breakeven on the add.
    PYRAMID:true,
    ADD_TRIGGER_ROI:5,          // add once ROI ≥ this % …
    ADD_FRAC:0.5,               // … a tranche of (original alloc × this)
    ADD_MIN_PEAK_KEEP:0.85,     // … only while still ≥85% of peak ROI (i.e. not rolling over)
    SOFT_THRESHOLD:true, SOFT_MISS_HAIRCUT:0.70, SOFT_MISS_MAX:1,
    SOFT_SCORE_BONUS:6, SOFT_BAND_BUBBLE:8, SOFT_BAND_RSI:6,
    WEIGHTS:{deriv:35,chain:25,senti:20,tech:20},
  },
  PORTFOLIO_DEFAULTS:{ maxLossPct:0.20, profitLockPct:0.80, riskPerTradePct:0.01 },
  STATE_FILE: process.env.STATE_FILE || './engine-state.json',
};
