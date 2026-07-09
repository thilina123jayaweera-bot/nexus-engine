// marketdata.js — headless market data. Connects to Binance mark-price WS,
// maintains LP (last price), per-symbol price buffers, RSI (span-based, the fixed
// version), bubble, funding, and a BTC regime (CORR). Runs entirely in Node.
const WebSocket = require('ws');
const cfg = require('./config');
const ex = require('./exchange');

const LP = {};                 // sym -> price
const buffers = {};            // sym -> [{p,t}]
const MKT = { fearGreed:50, btcDom:null };
const CORR = { btcMoveLastMin:0, btcVolatility:0, regimeStress:'CALM' };
let TK = [];                   // universe: [{s, funding, oi, rsi, bubble, mvrvZ, netflow, ... , h24}]
let ws=null, wsReconnecting=false;

function upsert(sym, price){
  LP[sym]=price;                                  // LP updates every tick (P&L marking stays real-time)
  const b=(buffers[sym]=buffers[sym]||[]);
  const now=Date.now();
  // Sample the analysis buffer every 10s (not every 1s tick): RSI over ~3 min of
  // smooth mark-price saturates at 5/95 on any drift — a 40-min window of 10s
  // samples behaves like real RSI and stops the fake oversold/overbought extremes.
  if(!b.length || now-b[b.length-1].t>=10000){
    b.push({p:price,t:now}); if(b.length>240)b.shift();
    computeRSIbubble(sym);
  }
}
function computeRSIbubble(sym){
  const t=TK.find(x=>x.s===sym); const b=buffers[sym]; if(!t||!b||b.length<30)return;
  const span=b[b.length-1].t-b[0].t;
  if(span>=900000){                                  // ≥15 min of samples before RSI is trusted
    const N=15,pts=[]; for(let k=0;k<N;k++)pts.push(b[Math.floor(k*(b.length-1)/(N-1))].p);
    let g=0,l=0; for(let i=1;i<pts.length;i++){const c=pts[i]-pts[i-1];if(c>0)g+=c;else l-=c;}
    const aG=g/(N-1),aL=l/(N-1);
    if(aL>0&&aG>0)t.rsi=Math.max(5,Math.min(95,100-(100/(1+aG/aL))));
    else if(aG>0&&aL===0)t.rsi=Math.min(95,Math.max(t.rsi||70,70));
    else if(aL>0&&aG===0)t.rsi=Math.max(5,Math.min(t.rsi||30,30));
  }
  const prices=b.map(x=>x.p),mn=Math.min(...prices),mx=Math.max(...prices);
  if(mx>mn)t.bubble=Math.max(10,Math.min(95,((LP[sym]-mn)/(mx-mn))*100));
}
function updateRegime(){
  const b=buffers['BTC']; if(!b||b.length<30)return;
  const now=Date.now(); const recent=b.filter(x=>now-x.t<60000);
  if(recent.length>=2){ const first=recent[0].p,last=recent[recent.length-1].p;
    CORR.btcMoveLastMin=((last-first)/first)*100; }
  const prices=b.slice(-60).map(x=>x.p); const mean=prices.reduce((a,x)=>a+x,0)/prices.length;
  const variance=prices.reduce((s,x)=>s+(x-mean)**2,0)/prices.length;
  CORR.btcVolatility=Math.sqrt(variance)/mean;
  CORR.regimeStress = CORR.btcVolatility>0.02?'EXTREME':CORR.btcVolatility>0.01?'ELEVATED':'CALM';
}

function connectWS(log){
  if(wsReconnecting)return; wsReconnecting=true;
  const streams=TK.slice(0,cfg.UNIVERSE_SIZE).map(t=>`${t.s.toLowerCase()}usdt@markPrice@1s`).join('/');
  const host = cfg.TESTNET?'stream.binancefuture.com':'fstream.binance.com';
  ws=new WebSocket(`wss://${host}/stream?streams=${streams}`);
  ws.on('open',()=>{ wsReconnecting=false; log(`market WS connected — ${Math.min(TK.length,cfg.UNIVERSE_SIZE)} feeds`); });
  ws.on('message',(raw)=>{ try{ const m=JSON.parse(raw); const d=m.data; if(d&&d.s){
      const sym=d.s.replace('USDT',''); upsert(sym, parseFloat(d.p)); if(sym==='BTC')updateRegime();
    }}catch(e){} });
  ws.on('close',()=>{ wsReconnecting=false; log('market WS closed — reconnecting in 3s'); setTimeout(()=>connectWS(log),3000); });
  ws.on('error',()=>{ try{ws.close();}catch(e){} });
}

async function refreshFunding(log){
  for(const t of TK.slice(0,cfg.UNIVERSE_SIZE)){
    const f=await ex.funding(t.s); if(f!=null)t.funding=f;
  }
}
async function refreshMacro(){
  try{ const r=await fetch('https://api.alternative.me/fng/?limit=1',{signal:AbortSignal.timeout(8000)});
    const j=await r.json(); if(j&&j.data&&j.data[0])MKT.fearGreed=parseInt(j.data[0].value,10);
  }catch(e){}
}

// Universe bootstrap — pull tradable symbols; seed neutral feature values that the
// live feeds/[data routes] then overwrite. (Extend to pull on-chain/social here.)
async function bootstrapUniverse(log){
  try{
    const info=await ex.pub('/fapi/v1/exchangeInfo');
    const syms=(info.symbols||[]).filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING')
      .map(s=>s.baseAsset).filter(s=>!s.includes('_')).slice(0,cfg.UNIVERSE_SIZE);
    TK=syms.map(s=>({s, funding:null, oi:null, rsi:null, bubble:null, mvrvZ:null, netflow:null,
      smartMoney:null, socialVol:null, galaxyScore:null, tieScore:null, ofi:null, liqL:null, liqS:null, h24:8}));
    log(`universe: ${TK.length} symbols`);
  }catch(e){ log('universe bootstrap failed — check network/testnet flag: '+e.message); TK=[]; }
}
function hasLiveData(sym){ return !!(buffers[sym]&&buffers[sym].length>=2&&LP[sym]>0); }

module.exports = { LP, MKT, CORR, buffers, getTK:()=>TK, hasLiveData,
  connectWS, refreshFunding, refreshMacro, bootstrapUniverse, upsert };
