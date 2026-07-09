// nexus-data-routes.js — live-data routes for the NEXUS engine.
// Signature matches server.js: module.exports = async (req, res, url) => boolean
// (returns true when it handled the request). Native fetch, cached, graceful.
// Vendor keys come from env (same ones as the browser/proxy).

const KEYS = {
  coinglass:  process.env.COINGLASS_KEY   || '',
  lunarcrush: process.env.LUNARCRUSH_KEY  || '',
  bgeometrics:process.env.BGEOMETRICS_KEY || '',
  coingecko:  process.env.COINGECKO_KEY   || '',
};

const cache = new Map();
async function cached(key, ttl, producer){
  const h = cache.get(key);
  if (h && Date.now()-h.t < ttl) return h.v;
  const v = await producer(); cache.set(key, {t:Date.now(), v}); return v;
}
// fetch JSON; a non-OK status or an {error} body returns null (so callers see a true miss)
async function j(url, opts={}){
  try{
    const r = await fetch(url, {signal:AbortSignal.timeout(8000), ...opts});
    if(!r.ok) return null;
    const d = await r.json();
    if(d && d.error) return null;
    return d;
  }catch(e){ return null; }
}
function syms(url){
  return (url.searchParams.get('symbols')||'BTC,ETH').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,60);
}

// ① DERIVATIVES — Binance funding + OI (live, keyless); liquidations via Coinglass if keyed
async function derivs(list){
  return cached('derivs:'+list.join(','), 60_000, async () => {
    const out = {};
    await Promise.all(list.map(async s => {
      const o = {};
      const pi = await j(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}USDT`);
      if (pi && pi.lastFundingRate!=null) o.funding = parseFloat(pi.lastFundingRate)*100;
      const oi = await j(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${s}USDT`);
      if (oi && oi.openInterest!=null) o.oi = parseFloat(oi.openInterest);
      if (KEYS.coinglass){
        const lq = await j(`https://open-api-v4.coinglass.com/api/futures/liquidation/coin?symbol=${s}`,
          { headers:{'CG-API-KEY':KEYS.coinglass} });
        if (lq && lq.data){ o.longLiq=lq.data.longLiquidationUsd; o.shortLiq=lq.data.shortLiquidationUsd; }
      }
      out[s] = o;
    }));
    return out;
  });
}

// ② ON-CHAIN — free BTC MVRV-Z (BGeometrics); netflow/smart-money via Coinglass if keyed
let BG_URL=null, BG_NEXT=0;
const BG_CANDS = [
  'https://bitcoin-data.com/v1/mvrv-zscore/last',
  'https://api.bgeometrics.com/v1/mvrv-zscore',
  'https://api.bgeometrics.com/v1/mvrvzscore',
  'https://bitcoin-data.com/v1/mvrv-zscore',
];
function pickNum(o){
  if(o==null)return null;
  if(typeof o==='number')return isFinite(o)?o:null;
  if(typeof o==='string')return (o!==''&&!isNaN(+o))?+o:null;
  if(Array.isArray(o))return pickNum(o[o.length-1]);
  if(typeof o==='object'){
    const ks=Object.keys(o); const p=ks.find(k=>/mvrv.*z|z.?score|^value$|^v$/i.test(k));
    if(p!=null){const v=pickNum(o[p]);if(v!=null)return v;}
    for(const k of ks){const v=o[k];if(typeof v==='number'||(typeof v==='string'&&v!==''&&!isNaN(+v)))return +v;}
    for(const k of ks){const r=pickNum(o[k]);if(r!=null)return r;}
  }
  return null;
}
async function btcMvrvZ(){
  return cached('btc-mvrvz', 43_200_000, async () => {   // 12h — respects the 15/day free limit
    const headers = KEYS.bgeometrics ? { Authorization:'Bearer '+KEYS.bgeometrics } : {};
    const tryU = async u => { const v=pickNum(await j(u,{headers})); return (v!=null&&isFinite(v))?v:null; };
    if(BG_URL){ const v=await tryU(BG_URL); if(v!=null)return v; BG_URL=null; }
    if(Date.now()<BG_NEXT)return null;
    for(const u of BG_CANDS){ const v=await tryU(u); if(v!=null){BG_URL=u;return v;} }
    BG_NEXT=Date.now()+86_400_000; return null;
  });
}
async function onchain(list){
  return cached('onchain:'+list.join(','), 600_000, async () => {
    const out = {};
    for(const s of list){
      const o = {};
      if(s==='BTC'){ const z=await btcMvrvZ(); if(z!=null)o.mvrvZ=z; }
      if(KEYS.coinglass){
        const nf = await j(`https://open-api-v4.coinglass.com/api/futures/exchange/netflow?symbol=${s}`,
          { headers:{'CG-API-KEY':KEYS.coinglass} });
        if(nf && nf.data && nf.data.netflow!=null) o.netflow = nf.data.netflow;
      }
      out[s]=o;
    }
    return out;
  });
}

// ③ SOCIAL — LunarCrush (free key)
async function social(list){
  return cached('social:'+list.join(','), 300_000, async () => {
    const out = {}; list.forEach(s=>out[s]={});
    if(!KEYS.lunarcrush) return out;
    const d = await j('https://lunarcrush.com/api4/public/coins/list/v1',
      { headers:{ Authorization:'Bearer '+KEYS.lunarcrush } });
    const rows = d && (d.data||d);
    if(Array.isArray(rows)){
      const map={}; for(const c of rows){ if(c && c.symbol) map[String(c.symbol).toUpperCase()]=c; }
      for(const s of list){ const c=map[s]; if(c) out[s]={ galaxy:c.galaxy_score, socialVol:c.social_volume_24h, tie:c.sentiment }; }
    }
    return out;
  });
}

// ④ MACRO — Fear & Greed + BTC dominance
async function macro(){
  return cached('macro', 300_000, async () => {
    const o = { fearGreed:50, btcDom:null, rates:process.env.MACRO_RATES||'NEUTRAL' };
    const fg = await j('https://api.alternative.me/fng/?limit=1');
    if(fg && fg.data && fg.data[0]) o.fearGreed = parseInt(fg.data[0].value,10);
    const gk = KEYS.coingecko ? `?x_cg_demo_api_key=${KEYS.coingecko}` : '';
    const g = await j(`https://api.coingecko.com/api/v3/global${gk}`);
    if(g && g.data && g.data.market_cap_percentage) o.btcDom = g.data.market_cap_percentage.btc;
    return o;
  });
}

// ⑤ MARKETS — CoinGecko coins/markets (24h change, market-cap rank). THE MISSING ROUTE.
async function markets(ids){
  ids = String(ids||'').slice(0,2000);
  if(!ids) return [];
  return cached('markets:'+ids, 60_000, async () => {
    const path = `/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}`
      + `&order=market_cap_desc&per_page=50&sparkline=false&price_change_percentage=1h,24h,7d`;
    // A demo key uses api.coingecko.com with x_cg_demo_api_key; keyless is heavily
    // rate-limited from cloud IPs (429), which is why it can come back empty.
    const url = KEYS.coingecko
      ? `https://api.coingecko.com${path}&x_cg_demo_api_key=${KEYS.coingecko}`
      : `https://api.coingecko.com${path}`;
    const d = await j(url);
    return Array.isArray(d) ? d : [];
  });
}
// Diagnostic: same call but returns the raw status/body so we can see WHY it's empty.
async function marketsDebug(ids){
  ids = String(ids||'bitcoin').slice(0,2000);
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&order=market_cap_desc&per_page=5&sparkline=false`
    + (KEYS.coingecko ? `&x_cg_demo_api_key=${KEYS.coingecko}` : '');
  try{
    const r = await fetch(url, {signal:AbortSignal.timeout(8000)});
    const text = await r.text();
    return { hasKey:!!KEYS.coingecko, httpStatus:r.status, ok:r.ok, bodyPreview:text.slice(0,300) };
  }catch(e){ return { hasKey:!!KEYS.coingecko, error:String(e && e.message || e) }; }
}

// ── dispatcher ──────────────────────────────────────────────────────────────
module.exports = async function(req, res, url){
  const p = url.pathname;
  const send = (o, code=200) => {
    res.writeHead(code, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(o)); return true;
  };
  if(p==='/ping')          return send({ ok:true, t:Date.now() });
  if(p==='/data/derivs')   return send(await derivs(syms(url)));
  if(p==='/data/onchain')  return send(await onchain(syms(url)));
  if(p==='/data/social')   return send(await social(syms(url)));
  if(p==='/data/macro')    return send(await macro());
  if(p==='/data/markets')  return send(await markets(url.searchParams.get('ids')));
  if(p==='/data/markets-debug') return send(await marketsDebug(url.searchParams.get('ids')));
  if(p==='/data/health')   return send({ status:'ok',
      keys:{ coinglass:!!KEYS.coinglass, lunarcrush:!!KEYS.lunarcrush, bgeometrics:!!KEYS.bgeometrics, coingecko:!!KEYS.coingecko },
      time:new Date().toISOString() });
  if(p.startsWith('/data/')) return send({ error:'Not Found', hint:'try /data/macro' }, 404);
  return false;
};
