// state.js — persistent engine state (trades, closed ledger, portfolio, cooldowns).
// JSON file so it survives restarts/redeploys. Carries the safety invariants we
// fixed in the browser: idempotent archive, CLOSED status, per-symbol cooldown.
const fs = require('fs');
const cfg = require('./config');

const S = {
  trades: [],            // open positions
  closedTrades: [],      // realized ledger (one row per close)
  lastCloseBySym: {},    // symbol -> {t, loss}  (re-entry cooldown)
  tradeId: 0,
  portfolio: {
    baseLeverage: cfg.LEVERAGE,
    startingEquity: cfg.CAPITAL, currentEquity: cfg.CAPITAL, peakEquity: cfg.CAPITAL,
    realizedPnL: 0, winStreak: 0, lossStreak: 0,
    drawdownLocked: false, drawdownLockUntil: 0, panicMode: false, panicUntil: 0,
    entryPauseUntil: 0,
    maxLossPct: cfg.PORTFOLIO_DEFAULTS.maxLossPct,
    profitLockPct: cfg.PORTFOLIO_DEFAULTS.profitLockPct,
    effectiveLossFloor: -(cfg.CAPITAL*cfg.PORTFOLIO_DEFAULTS.maxLossPct),
  },
  autoMode: cfg.AUTO_MODE,
  runtime: { dryRun: cfg.DRY_RUN, testnet: cfg.TESTNET, startedAt: Date.now() },
};

function load(){
  try{ if(fs.existsSync(cfg.STATE_FILE)){ const d=JSON.parse(fs.readFileSync(cfg.STATE_FILE,'utf8'));
    Object.assign(S, d);
    // sanitize: an OPEN position must never restore with stale close flags
    S.trades.forEach(x=>{ if(x.status!=='CLOSED'){ delete x._closing; delete x._archived; } });
  }}catch(e){}
}
let saveT=null;
function save(){ clearTimeout(saveT); saveT=setTimeout(()=>{
  try{ fs.writeFileSync(cfg.STATE_FILE, JSON.stringify(S)); }catch(e){}
},500); }

// idempotent close archival + streak/cooldown bookkeeping
function archive(tr){
  if(tr._archived)return; tr._archived=true;
  const pnl=tr.pnlUSD||0;
  S.portfolio.realizedPnL+=pnl;
  if(pnl>=0){S.portfolio.winStreak++;S.portfolio.lossStreak=0;} else {S.portfolio.lossStreak++;S.portfolio.winStreak=0;}
  S.lastCloseBySym[tr.sym]={t:Date.now(),loss:pnl<0};
  S.closedTrades.unshift({ id:tr.id, sym:tr.sym, direction:tr.direction, leverage:tr.leverage,
    alloc:tr.alloc, entry:tr.entry, exit:tr.exit, pnlUSD:+pnl.toFixed(2), pnlPct:+(tr.pnlPct||0).toFixed(2),
    closeReason:tr.closeReason||tr._closeAction, openTime:tr.openTime, closeTime:Date.now(),
    holdMin:+(((Date.now()-(tr.openTime||Date.now()))/60000)).toFixed(1), entryScore:tr.entryScore });
  if(S.closedTrades.length>500)S.closedTrades.pop();
  save();
}

module.exports = { S, load, save, archive };
