// decision.js — PURE decision logic, ported faithfully from index.html.
// Framework-free: takes token/market objects, returns scores/filters/sizing/exit
// actions. Identical math to the browser engine so behaviour matches. Advanced
// signals (RL, calibration, Phase19, full on-chain) are extension points marked TODO.
const { RULES } = require('./config');
const n = k => (RULES.WEIGHTS[k]||0)/100;

// ── SCORING — long vs short, 0..100 each ────────────────────────────────────
function dualScore(t, MKT, CORR){
  const clamp=(x)=>Math.max(0,Math.min(100,x));
  // Derivatives
  let LD=0,SD=0;
  LD+= t.funding<0.005?30:t.funding<0.05?8:2;      SD+= t.funding>0.05?32:t.funding>0.01?10:2;
  const liqTot=(t.liqL||0)+(t.liqS||0)+1;
  LD+= ((t.liqS||0)-(t.liqL||0))/liqTot*20;         SD+= ((t.liqL||0)-(t.liqS||0))/liqTot*20;
  LD+= (t.ofi||0)>1?18:(t.ofi||0)>0?8:0;            SD+= (t.ofi||0)<-1?18:(t.ofi||0)<0?8:0;
  // On-chain
  let LC=0,SC=0;
  LC+= t.netflow<-50?30:t.netflow<0?12:2;            SC+= t.netflow>50?28:t.netflow>0?10:2;
  LC+= t.mvrvZ<0.5?35:t.mvrvZ<1?20:t.mvrvZ<2.5?8:2;  SC+= t.mvrvZ>3?32:t.mvrvZ>2?18:5;
  LC+= (t.smartMoney||0)*22;                         SC+= (1-(t.smartMoney||0))*22;
  // Sentiment (contrarian at extremes)
  let LS=0,SS=0;
  LS+= (MKT.fearGreed||50)<20?22:(MKT.fearGreed)<30?15:(MKT.fearGreed)<50?8:3;
  SS+= (MKT.fearGreed||50)>75?28:(MKT.fearGreed)>60?20:(MKT.fearGreed)>50?10:3;
  LS+= (t.galaxyScore||50)>65?12:5;                  SS+= (t.tieScore||0.5)<0.3?12:4;
  // Technical
  let LE=0,SE=0;
  const rsiOk=Number.isFinite(t.rsi)&&t.rsi>=3&&t.rsi<=97;
  LE+= rsiOk?(t.rsi<28?35:t.rsi<40?20:t.rsi<60?8:2):2;
  SE+= rsiOk?(t.rsi>72?35:t.rsi>60?20:t.rsi>40?8:2):2;
  LE+= (t.bubble||50)<40?10:2;                        SE+= (t.bubble||50)>70?10:2;

  let longTotal = clamp(LD)*n('deriv')+clamp(LC)*n('chain')+clamp(LS)*n('senti')+clamp(LE)*n('tech');
  let shortTotal= clamp(SD)*n('deriv')+clamp(SC)*n('chain')+clamp(SS)*n('senti')+clamp(SE)*n('tech');
  // BTC regime multiplier (the biggest lever)
  if(CORR){
    const m=CORR.btcMoveLastMin||0;
    if(CORR.regimeStress==='EXTREME'&&m<-0.5) longTotal*=0.20;
    else if(m<-0.15) longTotal*=0.70;
    if(m<-0.5) shortTotal*=1.40; else if(m<-0.15) shortTotal*=1.12;
    if(m>0.5) shortTotal*=0.20; else if(m>0.15) shortTotal*=0.70;
    if(m>0.15) longTotal*=1.15;
  }
  longTotal=clamp(longTotal); shortTotal=clamp(shortTotal);
  const direction = longTotal>=shortTotal?'LONG':'SHORT';
  const total = Math.max(longTotal,shortTotal);
  return { long:{total:longTotal}, short:{total:shortTotal}, direction,
           total, conviction:Math.abs(longTotal-shortTotal) };
}

// ── ENTRY FILTERS — every gate must pass; signal gates are soft ─────────────
function applyFilters(t, ctx){
  const { MKT, CORR, trades, lastCloseBySym, portfolio, hasLiveData } = ctx;
  const dual=dualScore(t,MKT,CORR);
  const dir=dual.direction;
  const ps=dir==='LONG'?dual.long:dual.short;
  const targetPct=Math.max(t.h24||5, ctx.stopLoss*RULES.FULL_TARGET_MULTI);
  const rr=Math.max(0.5,Math.min(targetPct/ctx.stopLoss,8));
  const filters=[]; let pass=true;
  const G=(label,ok)=>{filters.push({label,pass:ok}); if(!ok)pass=false;};

  G('IN POSITION', !trades.some(x=>x.sym===t.s&&x.status!=='CLOSED'));
  G('LIVE DATA', hasLiveData(t.s)&&ps&&Number.isFinite(ps.total));   // kills phantom/no-data tokens
  const lc=lastCloseBySym[t.s];
  G('COOLDOWN', !(lc&&lc.loss&&(Date.now()-lc.t)<RULES.REENTRY_COOLDOWN_MIN*60000));
  const thr=RULES.MIN_PROFIT_SCORE+(portfolio.lossStreak>=5?13:portfolio.lossStreak>=3?8:0);
  G(`SCORE ${ps.total|0}>=${thr}`, ps.total>=thr);
  G(`R:R ${rr.toFixed(1)}>=${RULES.MIN_RR}`, rr>=RULES.MIN_RR);
  G(`CONV ${dual.conviction|0}>=${RULES.MIN_CONVICTION}`, dual.conviction>=RULES.MIN_CONVICTION);
  G('GUARD', !portfolio.drawdownLocked && !portfolio.panicMode);
  if(dir==='SHORT'&&!ctx.allowShorts)G('SHORTS ENABLED',false);
  // regime hard blocks
  if(CORR){
    if(dir==='LONG') G('BTC not dumping', !(CORR.btcMoveLastMin<-0.5));
    if(dir==='SHORT')G('BTC not pumping', !(CORR.btcMoveLastMin>0.5));
    G('VOL ok', (CORR.btcVolatility||0)<0.025);
  }
  // soft signal gates (bubble/RSI) — near-miss = size haircut, funding stays hard
  let softMisses=0;
  const canSoften=RULES.SOFT_THRESHOLD && ps.total>=thr+RULES.SOFT_SCORE_BONUS;
  const soft=(label,hard,band)=>{ if(hard){filters.push({label,pass:true});return;}
    if(canSoften&&band){softMisses++;filters.push({label:label+' ~SOFT',pass:true});return;}
    filters.push({label,pass:false}); pass=false; };
  const rsiValid=Number.isFinite(t.rsi)&&t.rsi>=3&&t.rsi<=97;
  if(dir==='LONG'){
    soft(`BUBBLE<75`, (t.bubble||50)<75, (t.bubble||50)<75+RULES.SOFT_BAND_BUBBLE);
    G(`FUND<6%`, t.funding<0.06);
    soft(`RSI<58`, rsiValid&&t.rsi<58, rsiValid&&t.rsi<58+RULES.SOFT_BAND_RSI);
  }else{
    soft(`BUBBLE>35`, (t.bubble||50)>35, (t.bubble||50)>35-RULES.SOFT_BAND_BUBBLE);
    G(`FUND>1%`, t.funding>0.01);
    soft(`RSI>50`, rsiValid&&t.rsi>50, rsiValid&&t.rsi>50-RULES.SOFT_BAND_RSI);
  }
  let sizeMult=1;
  if(softMisses>RULES.SOFT_MISS_MAX){G(`SOFT MISS ${softMisses}`,false);}
  else if(softMisses>0) sizeMult=Math.pow(RULES.SOFT_MISS_HAIRCUT,softMisses);
  return { pass, filters, direction:dir, ps, rr, targetPct, conviction:dual.conviction, dual, sizeMult, softMisses };
}

// ── SIZING — the single source of truth (Kelly × risk × regime × smallcap-cap) ─
function computeEntrySize(t, f, ctx){
  const { CORR, portfolio, isSmallCap } = ctx;
  let lev=adaptiveLeverage(portfolio, MKTfg(ctx));
  const isSC=isSmallCap(t);
  if(isSC) lev=Math.min(lev, RULES.SMALLCAP_LEV_CAP);
  const equity=portfolio.currentEquity||ctx.capital;
  const riskMargin=(equity*ctx.portfolioDefaults.riskPerTradePct)/((ctx.stopLoss/100)*lev);
  // fractional Kelly from R:R (win prob defaults to a calibrated-ish prior on score)
  const pWin=Math.max(0.35,Math.min(0.7, 0.4 + (f.ps.total-72)/200));
  const R=f.rr; const kf=Math.max(0,(pWin*R-(1-pWin))/R)*RULES.KELLY_FRACTION;
  const kelly=Math.min(ctx.capital*kf, ctx.capital*0.20);
  let margin=Math.min(kelly, riskMargin, ctx.capital/ctx.maxPos);
  const regimeMult=(CORR&&RULES.REGIME_SIZE[CORR.regimeStress])||1;
  margin=margin*(f.sizeMult||1)*regimeMult;
  if(isSC) margin=Math.min(margin,(ctx.capital/ctx.maxPos)*RULES.SMALLCAP_MAX_ALLOC_FRAC);
  let effSL=Math.max(0.4, Math.min(ctx.stopLoss, RULES.MAX_STOP_ROI/Math.max(1,lev)));
  const why=[]; if((f.softMisses||0)>0)why.push(`soft x${(f.sizeMult).toFixed(2)}`);
  if(regimeMult!==1)why.push(`${CORR.regimeStress} x${regimeMult}`); if(isSC)why.push('smallcap-cap');
  return { margin:+margin.toFixed(2), leverage:lev, sl:effSL, isSmallCap:isSC, notional:+(margin*lev).toFixed(2), note:why.join(', ') };
}
function MKTfg(ctx){ return ctx.MKT&&ctx.MKT.fearGreed||50; }
function adaptiveLeverage(portfolio, fg){
  let lev=portfolio.baseLeverage||3;
  if(portfolio.winStreak>=3) lev=Math.round(lev*RULES.WIN_STREAK_LEV_BOOST);
  if(portfolio.lossStreak>=2) lev=Math.round(lev*RULES.LOSS_STREAK_LEV_CUT);
  if(fg>75) lev=Math.max(1,lev-1);            // greed → de-risk
  return Math.max(1,Math.min(8,lev));
}

// ── EXIT BRAIN — priority ladder, first match wins ──────────────────────────
function evalTrade(tr, ctx){
  const { MKT, CORR, isSmallCap } = ctx;
  const t=ctx.tokenBySym(tr.sym); if(!t) return {action:'HOLD',reason:'no data'};
  const lev=tr.leverage||3;
  const dual=dualScore(t,MKT,CORR);
  const es=tr.direction==='LONG'?dual.long:dual.short;
  const opp=tr.direction==='LONG'?dual.short:dual.long;
  const pnl=tr.pnlPct||0;                       // ROI %
  const holdMin=(Date.now()-(tr.openTime||Date.now()))/60000;
  const scoreWeak=(es.total-(tr.entryScore||60))<-RULES.SCORE_DROP_EXIT;
  const exhausted=tr.direction==='LONG'?(Number.isFinite(t.rsi)&&t.rsi>72):(Number.isFinite(t.rsi)&&t.rsi<28);
  const target=Math.max(tr.targetPct||8, ctx.stopLoss*2);
  const A=(action,reason,urgent=false)=>({action,reason,urgent});
  if(pnl<=-ctx.stopLoss*lev)                         return A('STOP OUT',`ROI ${pnl.toFixed(1)}% ≤ stop`,true);
  if(pnl<=-(ctx.capital*0.05/(tr.alloc||1))*100)     return A('CAP STOP',`loss ≥5% capital`,true);
  if(pnl>=target && exhausted)                       return A('CLOSE TP',`target hit + exhausted`,true);
  if(pnl<-ctx.stopLoss*lev*0.55 && scoreWeak)        return A('EARLY EXIT',`losing + score dropped`,true);
  if(opp.total-es.total>RULES.ROTATE_ADVANTAGE)      return A('CLOSE FLIP',`opposite stronger`,true);
  if(holdMin>RULES.MAX_HOLD_MINUTES && Math.abs(pnl)<1) return A('CLOSE STALE',`flat ${holdMin|0}m`,true);
  if(pnl>=Math.max(RULES.PARTIAL_TAKE_PCT,ctx.stopLoss)*lev && !tr.partialTaken) return A('PARTIAL TAKE',`bank ${(RULES.PARTIAL_TAKE_FRAC*100)|0}% at ≥1R`,false);
  if(pnl>=RULES.TRAIL_START_PCT*lev && !scoreWeak)   return A('TRAIL STOP',`trail at +${(pnl*RULES.TRAIL_LOCK).toFixed(1)}%`,false);
  if(!scoreWeak && !exhausted)                        return A('HOLD',`score ${es.total|0}/100`,false);
  return A('MONITOR',`weakening ${es.total|0}/100`,false);
}

module.exports = { dualScore, applyFilters, computeEntrySize, adaptiveLeverage, evalTrade };
