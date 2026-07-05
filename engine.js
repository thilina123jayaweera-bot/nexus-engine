// engine.js — the headless decision loop. Every EVAL_INTERVAL: score → filter →
// size → enter. Every TICK: mark open positions to market and run the exit ladder.
// Risk guards PAUSE entries (timed, auto-resume) but never disable AUTO — so exits
// keep being managed (the browser bug we fixed, preserved here).
const cfg = require('./config');
const md = require('./marketdata');
const ex = require('./exchange');
const { S, save, archive } = require('./state');
const D = require('./decision');
const df = require('./datafeed');

const log=(m,tag='·')=>{ const line=`[${new Date().toISOString()}] ${tag} ${m}`;
  console.log(line); S._log=(S._log||[]); S._log.unshift(line); if(S._log.length>200)S._log.pop(); };
const isSmallCap=t=> (t.marketCapRank||999)>100 || (t.oi||0)<5_000_000;
const tokenBySym=s=> md.getTK().find(t=>t.s===s);
const ctxBase=()=>({ MKT:md.MKT, CORR:md.CORR, trades:S.trades, lastCloseBySym:S.lastCloseBySym,
  portfolio:S.portfolio, hasLiveData:md.hasLiveData, isSmallCap, tokenBySym,
  stopLoss:cfg.STOP_LOSS, allowShorts:cfg.ALLOW_SHORTS, capital:cfg.CAPITAL, maxPos:cfg.MAX_POS,
  portfolioDefaults:cfg.PORTFOLIO_DEFAULTS });

function markToMarket(){
  for(const tr of S.trades){ if(tr.status==='CLOSED')continue;
    const p=md.LP[tr.sym]; if(!p)continue; tr.mark=p;
    const move=(p-tr.entry)/tr.entry*(tr.direction==='LONG'?1:-1);
    tr.pnlPct=move*100*tr.leverage;
    tr.pnlUSD=(tr.alloc||0)*move*tr.leverage;
  }
}
function equity(){ const un=S.trades.filter(t=>t.status!=='CLOSED').reduce((s,t)=>s+(t.pnlUSD||0),0);
  S.portfolio.currentEquity=S.portfolio.startingEquity+S.portfolio.realizedPnL+un;
  S.portfolio.peakEquity=Math.max(S.portfolio.peakEquity,S.portfolio.currentEquity); return un; }

// risk guards — pause ENTRIES only, AUTO stays on, timed auto-resume
function riskGuards(){
  const P=S.portfolio; const un=equity();
  const floor=Math.max(-P.peakEquity*P.maxLossPct, P.effectiveLossFloor);
  if(P.realizedPnL+un<=floor && !P.drawdownLocked){
    P.drawdownLocked=true; P.drawdownLockUntil=Date.now()+cfg.RULES.LOCK_COOLDOWN_MIN*60000;
    closeAll('LOSS LIMIT'); log(`LOSS LIMIT — entries paused ${cfg.RULES.LOCK_COOLDOWN_MIN}m, AUTO stays on`,'🛑');
  }
  if(Math.abs(md.CORR.btcMoveLastMin)>=4 && !P.panicMode){
    P.panicMode=true; P.panicUntil=Date.now()+3600000; closeAll('PANIC'); log('PANIC — 1h entry pause, AUTO stays on','🚨');
  }
  if(P.panicMode&&Date.now()>=P.panicUntil){P.panicMode=false;log('panic lifted','🟢');}
  if(P.drawdownLocked&&P.drawdownLockUntil&&Date.now()>=P.drawdownLockUntil){P.drawdownLocked=false;log('drawdown pause lifted','🟢');}
  if(P.lossStreak>=5&&Date.now()>P.entryPauseUntil){P.entryPauseUntil=Date.now()+3600000;log('5-loss streak — 1h entry pause, AUTO stays on','🚨');}
  return !P.drawdownLocked && !P.panicMode && Date.now()>=P.entryPauseUntil;
}

async function closePosition(tr, action){
  if(tr.status==='CLOSED'||tr._closing)return; tr._closing=true; tr.status='CLOSED';
  tr._closeAction=action; tr.closeReason=action; tr.exit=md.LP[tr.sym]||tr.entry;
  try{ await ex.cancelAll(tr.sym); await ex.reduceClose(tr.sym,tr.direction,tr.qty,log); }
  catch(e){ log(`CLOSE FAILED ${tr.sym}: ${e.message} — verify on exchange`,'🚫'); }
  archive(tr); log(`${action} ${tr.sym} ${(tr.pnlPct||0).toFixed(1)}% ($${(tr.pnlUSD||0).toFixed(2)})`, (tr.pnlUSD||0)>=0?'✅':'⛔');
}
async function closeAll(why){ for(const tr of S.trades.filter(t=>t.status!=='CLOSED')) await closePosition(tr,'CLOSE '+why); }

async function manageExits(){
  markToMarket();
  for(const tr of S.trades){ if(tr.status==='CLOSED')continue;
    const ev=D.evalTrade(tr, ctxBase());
    tr.aiEval=ev;
    if(['STOP OUT','CAP STOP','CLOSE TP','EARLY EXIT','CLOSE FLIP','CLOSE STALE'].includes(ev.action) || ev.action.startsWith('CLOSE ')){
      await closePosition(tr, ev.action);
    } else if(ev.action==='PARTIAL TAKE' && !tr.partialTaken){
      tr.partialTaken=true; const q=(tr.qty||0)*cfg.RULES.PARTIAL_TAKE_FRAC;
      try{ await ex.reduceClose(tr.sym,tr.direction,q,log); log(`PARTIAL TAKE ${tr.sym} +${(tr.pnlPct||0).toFixed(1)}%`,'💰'); }catch(e){}
    } else if(ev.action==='TRAIL STOP'){ tr.trailSL=(tr.pnlPct||0)*cfg.RULES.TRAIL_LOCK; }
  }
  save();
}

async function scanAndEnter(){
  if(!S.autoMode){ log('scan skipped — AUTO off','🔎'); return; }
  if(!riskGuards()){ log('scan skipped — risk pause active (entries paused, AUTO on)','🔎'); return; }
  const open=S.trades.filter(t=>t.status!=='CLOSED').length;
  if(open>=cfg.MAX_POS){ log(`scan skipped — at max positions (${open}/${cfg.MAX_POS})`,'🔎'); return; }
  const cands=[]; let scanned=0, noData=0; const all=[];
  for(const t of md.getTK()){
    scanned++;
    if(!md.hasLiveData(t.s)){ noData++; continue; }
    const f=D.applyFilters(t, ctxBase());
    all.push({sym:t.s, dir:f.direction, score:f.ps.total|0, fail:(f.filters.find(x=>!x.pass)||{}).label||'PASS'});
    if(f.pass) cands.push({t,f,score:f.ps.total});
  }
  all.sort((a,b)=>b.score-a.score);
  const top5=all.slice(0,5).map(x=>`${x.sym}:${x.score}${x.dir==='SHORT'?'s':''}`).join(' ');
  if(cands.length===0){
    const b=all[0];
    log(`SCAN: ${scanned} tok, ${noData} no-data, 0 qualified · top5 [${top5}] · best fail: ${b?`${b.sym} ${b.fail}`:'n/a'} · F&G ${md.MKT.fearGreed} ${md.CORR.regimeStress}`,'🔎');
    return;
  }
  cands.sort((a,b)=>b.score-a.score);
  log(`SCAN: ${scanned} tok, ${cands.length} qualified · top5 [${top5}] → entering ${Math.min(cands.length,cfg.MAX_POS-open)}`,'🔎');
  for(const {t,f} of cands.slice(0, cfg.MAX_POS-open)){
    const sz=D.computeEntrySize(t,f,ctxBase());
    const price=md.LP[t.s]; if(!price||sz.margin<5)continue;
    const qty=+((sz.notional)/price).toFixed(6);
    log(`ENTER ${f.direction} ${t.s} $${sz.margin} ${sz.leverage}x score ${f.ps.total|0}${sz.note?` (${sz.note})`:''}`,'📈');
    try{
      await ex.marketOrder(t.s, f.direction==='LONG'?'BUY':'SELL', qty, log);
      const slPrice=+(price*(1-(f.direction==='LONG'?1:-1)*sz.sl/100)).toFixed(8);
      await ex.stopMarket(t.s, f.direction, qty, slPrice, log);   // exchange-side protection
      S.trades.push({ id:++S.tradeId, sym:t.s, direction:f.direction, leverage:sz.leverage,
        entry:price, qty, alloc:sz.margin, notional:sz.notional, sl:sz.sl, targetPct:f.targetPct,
        entryScore:f.ps.total, openTime:Date.now(), status:'OPEN', pnlPct:0, pnlUSD:0, isSmallCap:sz.isSmallCap });
    }catch(e){ log(`ENTRY FAILED ${t.s}: ${e.message}`,'🚫'); }
  }
  save();
}

let evalT=null, tickT=null;
async function start(){
  log(`ENGINE START · DRY_RUN=${cfg.DRY_RUN} · TESTNET=${cfg.TESTNET} · AUTO=${S.autoMode}`,'⚡');
  await md.bootstrapUniverse(log);
  await md.refreshMacro(); await md.refreshFunding(log);
  md.connectWS(log);
  clearInterval(evalT); clearInterval(tickT);
  tickT=setInterval(()=>manageExits().catch(e=>log('tick err '+e.message,'⚠')), cfg.TICK_MS);
  evalT=setInterval(async()=>{ await md.refreshMacro(); await md.refreshFunding(log);
    await df.enrich(md.getTK(), md.MKT, log).catch(e=>log('datafeed err '+e.message,'⚠'));
    scanAndEnter().catch(e=>log('scan err '+e.message,'⚠')); }, cfg.EVAL_INTERVAL_MS);
  setTimeout(async()=>{ await df.enrich(md.getTK(), md.MKT, log).catch(()=>{});
    scanAndEnter().catch(()=>{}); }, 15000);  // first enrich + scan once data warms
}
function stop(){ clearInterval(evalT); clearInterval(tickT); log('engine stopped','⏹'); }

module.exports = { start, stop, closeAll, S, log,
  setAuto:(v)=>{S.autoMode=!!v;save();log(`AUTO ${v?'ON':'OFF (manual)'}`,'🎛');},
  setDryRun:(v)=>{cfg.DRY_RUN=!!v;S.runtime.dryRun=!!v;log(`DRY_RUN ${v}`,'🎛');} };
