// datafeed.js — enriches the engine's TK universe with LIVE signals by calling the
// engine's own /data/* routes (same process, over localhost). This is what makes the
// server-side decisions run on real derivatives/on-chain/social data instead of the
// seeded defaults. Defensive: any missing route/field simply leaves the prior value,
// so it degrades gracefully to seeds rather than crashing.
const cfg = require('./config');
const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const num = v => (v!=null && isFinite(+v)) ? +v : null;

async function j(url){ try{ const r=await fetch(url,{signal:AbortSignal.timeout(8000)}); return await r.json(); }catch(e){ return null; } }
const set=(t,k,v)=>{ const n=num(v); if(n!=null)t[k]=n; };

// CoinGecko id map for the markets route (extend as needed; unknowns are skipped).
const CG_ID={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',XRP:'ripple',
  ADA:'cardano',AVAX:'avalanche-2',DOGE:'dogecoin',LINK:'chainlink',DOT:'polkadot',
  MATIC:'matic-network',LTC:'litecoin',ATOM:'cosmos',UNI:'uniswap',TIA:'celestia'};

async function enrich(TK, MKT, log){
  const syms=TK.slice(0,cfg.UNIVERSE_SIZE).map(t=>t.s).join(',');
  const ids=TK.slice(0,cfg.UNIVERSE_SIZE).map(t=>CG_ID[t.s]).filter(Boolean).join(',');
  const [derivs,onchain,social,markets,macro]=await Promise.all([
    j(`${BASE}/data/derivs?symbols=${syms}`),
    j(`${BASE}/data/onchain?symbols=${syms}`),
    j(`${BASE}/data/social?symbols=${syms}`),
    ids?j(`${BASE}/data/markets?ids=${ids}`):null,
    j(`${BASE}/data/macro`),
  ]);
  let hit=0;
  for(const t of TK){
    const d=derivs&&derivs[t.s];
    if(d){ set(t,'oi',d.oi); set(t,'liqL',d.longLiq??d.liqL); set(t,'liqS',d.shortLiq??d.liqS);
           set(t,'ofi',d.ofi??d.orderFlow); set(t,'funding',d.funding); hit++; }
    const o=onchain&&onchain[t.s];
    if(o){ set(t,'netflow',o.netflow); set(t,'mvrvZ',o.mvrvZ); set(t,'smartMoney',o.smartMoney); }
    const s=social&&social[t.s];
    if(s){ set(t,'galaxyScore',s.galaxy??s.galaxyScore); set(t,'socialVol',s.socialVol??s.social);
           set(t,'tieScore',s.tie??s.tieScore); }
  }
  // markets → 24h change + market-cap rank (used for small-cap detection)
  if(Array.isArray(markets)){
    for(const m of markets){
      const sym=Object.keys(CG_ID).find(k=>CG_ID[k]===m.id);
      const t=sym&&TK.find(x=>x.s===sym); if(!t)continue;
      set(t,'h24',Math.abs(m.price_change_percentage_24h||0));
      if(m.market_cap_rank)t.marketCapRank=m.market_cap_rank;
    }
  }
  // market-wide: BTC MVRV-Z + Fear&Greed + dominance
  if(macro){ set(MKT,'fearGreed',macro.fearGreed); set(MKT,'btcDom',macro.btcDom); }
  if(onchain&&onchain.BTC&&onchain.BTC.mvrvZ!=null)MKT.mvrvZ=+onchain.BTC.mvrvZ;
  log(`datafeed: enriched ${hit}/${TK.length} from /data/* (derivs${derivs?'✓':'✗'} onchain${onchain?'✓':'✗'} social${social?'✓':'✗'} markets${markets?'✓':'✗'})`,'📡');
}
module.exports = { enrich };
