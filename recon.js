// recon.js — reconciliation gate. Refuses NEW entries when the engine's open
// positions don't match what the exchange actually holds. Catches:
//   ORPHAN       exchange holds a position the engine isn't tracking
//   PHANTOM      engine thinks it holds something the exchange doesn't
//   SIDE_MISMATCH long vs short disagreement
//   QTY_MISMATCH  size drift beyond tolerance (warn)
// This is the +196-vs-−152 class of bug — the engine trading one set of coins
// while the account holds another. A position diff catches it completely.
//
// Design (matches the engine's own philosophy: guards pause ENTRIES, not exits):
//   - gates entries only; manageExits()/closePosition() keep working so you can
//     always flatten.
//   - FAILS CLOSED: if it can't verify (fetch error), it blocks entries rather
//     than trading blind.
//   - SKIPS in DRY_RUN / no keys: there are no real positions to reconcile, and
//     simulated trades would all look like phantoms.
//   - uses the engine's existing signed exchange layer — no extra API keys.
const cfg = require('./config');
const ex = require('./exchange');

function openTrades(S){ return S.trades.filter(t => t.status !== 'CLOSED' && Math.abs(t.qty || 0) > 0); }

async function reconcileGate(S, log, opts = {}) {
  if (cfg.DRY_RUN || !cfg.API_KEY) return { safe: true, skipped: 'dry-run or no keys' };
  const qtyTolFrac = opts.qtyTolFrac != null ? opts.qtyTolFrac : 0.02;  // 2% (partial fills/rounding)

  let live;
  try { live = await ex.positions(); }
  catch (e) {
    if (log) log(`RECON: exchange fetch failed (${e.message}) — blocking entries (fail-closed)`, '🚫');
    return { safe: false, alarms: [{ level: 'critical', type: 'RECON_ERROR', detail: e.message }] };
  }

  const byEx = new Map(live.map(p => [p.symbol, p]));          // "BTCUSDT" -> {amt, entry}
  const open = openTrades(S);
  const byBot = new Map(open.map(t => [t.sym + 'USDT', t]));   // engine uses bare "BTC"
  const alarms = [];

  for (const [sym, p] of byEx)
    if (!byBot.has(sym)) alarms.push({ level: 'critical', type: 'ORPHAN', symbol: sym, detail: `exchange holds ${p.amt} ${sym} (entry ${p.entry}) the engine is not tracking` });

  for (const [sym, t] of byBot)
    if (!byEx.has(sym)) alarms.push({ level: 'critical', type: 'PHANTOM', symbol: sym, detail: `engine believes ${t.direction} ${t.qty} ${sym} is open; exchange shows none` });

  for (const [sym, t] of byBot) {
    const p = byEx.get(sym); if (!p) continue;
    const botSigned = t.direction === 'LONG' ? Math.abs(t.qty) : -Math.abs(t.qty);
    if (Math.sign(botSigned) !== Math.sign(p.amt))
      alarms.push({ level: 'critical', type: 'SIDE_MISMATCH', symbol: sym, detail: `engine ${t.direction} (${t.qty}) vs exchange amt ${p.amt}` });
    else {
      const rel = Math.abs(Math.abs(botSigned) - Math.abs(p.amt)) / Math.max(Math.abs(p.amt), 1e-9);
      if (rel > qtyTolFrac)
        alarms.push({ level: 'warn', type: 'QTY_MISMATCH', symbol: sym, detail: `engine qty ${t.qty} vs exchange ${Math.abs(p.amt)} (${(rel * 100).toFixed(1)}%)` });
    }
  }

  const critical = alarms.filter(a => a.level === 'critical');
  const safe = critical.length === 0;
  if (!safe && log) { log(`RECON HALT — ${critical.map(a => a.type + ' ' + a.symbol).join(', ')}`, '🛑'); for (const a of critical) log(`  ${a.detail}`, '🛑'); }
  return { safe, alarms };
}

module.exports = { reconcileGate, openTrades };
