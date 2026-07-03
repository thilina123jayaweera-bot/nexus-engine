// ════════════════════════════════════════════════════════════════════════
// nexus-data-routes.js — live-data routes for the NEXUS engine.
// Designed to bolt onto the EXISTING raw-http nexus-proxy (server.js) with
// NO new dependencies (native fetch, Node 18+). Does not touch the Binance
// order-proxy logic.
//
// Wire-up in server.js (two lines): require this, then call it FIRST inside
// the request handler:
//     const handleNexusData = require('./nexus-data-routes');
//     ...
//     if (handleNexusData(req, res)) return;   // owns /ping and /data/*
//
// handleNexusData returns TRUE if it took ownership of the request (and will
// write the response itself, possibly async), FALSE to let server.js continue.
//
// Point the uptime bot at  /ping  (zero upstream work — protects vendor quota).
// Set vendor keys as Render env vars: COINGLASS_KEY, LUNARCRUSH_KEY, etc.
// ════════════════════════════════════════════════════════════════════════
const KEYS = {
  coinglass:  process.env.COINGLASS_KEY   || '',
  lunarcrush: process.env.LUNARCRUSH_KEY  || '',
  santiment:  process.env.SANTIMENT_KEY   || '',
  glassnode:  process.env.GLASSNODE_KEY   || '',
  coingecko:  process.env.COINGECKO_KEY   || '',
  bgeometrics: process.env.BGEOMETRICS_KEY || '',   // free BTC on-chain (MVRV-Z), 15 req/day
};
const CG = 'https://open-api-v4.coinglass.com';
const FETCH_TIMEOUT = 8000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function corsHeaders(reqOrigin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN === '*' ? (reqOrigin || '*') : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function sendJSON(res, origin, obj, status = 200) {
  res.writeHead(status, { ...corsHeaders(origin), 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---- TTL cache: one snapshot fanned out to all clients ----
const cache = new Map();
const CACHE_MAX = 64;
async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const data = await producer();
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, { exp: Date.now() + ttlMs, data });
  return data;
}
// fetch→json with hard timeout; never throws
async function j(url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
const parseSyms = (sp) => String(sp.get('symbols') || 'BTC')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 50);
const LC_TOPIC = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };  // extend; fallback = lowercase symbol

// ① DERIVATIVES — funding+OI from Binance (free); liquidations from Coinglass
async function derivs(syms) {
  return cached('derivs:' + syms.join(','), 60_000, async () => {
    const result = {};
    await Promise.all(syms.map(async sym => {
      const pair = sym + 'USDT', o = {};
      const prem = await j(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`);
      if (prem && prem.lastFundingRate != null) o.funding = parseFloat(prem.lastFundingRate) * 100;
      const oi = await j(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`);
      if (oi && oi.openInterest != null) o.oi = parseFloat(oi.openInterest);
      if (KEYS.coinglass) {
        const liq = await j(`${CG}/api/futures/liquidation/aggregated-history?symbol=${sym}&interval=1h&limit=1`,
          { headers: { 'CG-API-KEY': KEYS.coinglass, accept: 'application/json' } });
        const row = liq && liq.data && liq.data[liq.data.length - 1];
        if (row) {
          o.liqL = Math.round(parseFloat(row.longLiquidationUsd  || row.long_liquidation_usd  || 0) / 1000);
          o.liqS = Math.round(parseFloat(row.shortLiquidationUsd || row.short_liquidation_usd || 0) / 1000);
        }
      }
      result[sym] = o;
    }));
    return result;
  });
}

// ── FREE BTC MVRV-Z (BGeometrics / bitcoin-data.com) — Glassnode replacement ──
// Free tier is ~15 req/day, so this is cached 12h (MVRV-Z is a once-daily metric).
// The exact metric slug/response shape isn't publicly fixed, so we try a few
// candidate URLs, PIN whichever works, and extract the value from any JSON shape.
// Add BGEOMETRICS_KEY (free, by registration) if the keyless path is rejected.
let BG_URL = null, BG_NEXT_TRY = 0;
const BG_CANDIDATES = [
  'https://bitcoin-data.com/v1/mvrv-zscore/last',
  'https://api.bgeometrics.com/v1/mvrv-zscore',
  'https://api.bgeometrics.com/v1/mvrvzscore',
  'https://bitcoin-data.com/v1/mvrv-zscore',
];
function bgHeaders() { return KEYS.bgeometrics ? { Authorization: 'Bearer ' + KEYS.bgeometrics } : {}; }
// pull the most plausible numeric value out of whatever JSON shape comes back
function pickNumber(o) {
  if (o == null) return null;
  if (typeof o === 'number') return isFinite(o) ? o : null;
  if (typeof o === 'string') return (o !== '' && !isNaN(+o)) ? +o : null;
  if (Array.isArray(o)) return pickNumber(o[o.length - 1]);   // time series → latest
  if (typeof o === 'object') {
    const keys = Object.keys(o);
    const pref = keys.find(k => /mvrv.*z|z.?score|^value$|^v$/i.test(k));
    if (pref != null) { const v = pickNumber(o[pref]); if (v != null) return v; }
    for (const k of keys) { const v = o[k]; if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(+v))) return +v; }
    for (const k of keys) { const r = pickNumber(o[k]); if (r != null) return r; }
  }
  return null;
}
async function btcMvrvZ() {
  return cached('btc-mvrvz', 43_200_000, async () => {        // 12h cache → ~2 calls/day, well under 15/day
    const headers = bgHeaders();
    const tryUrl = async u => { const v = pickNumber(await j(u, { headers })); return (v != null && isFinite(v)) ? v : null; };
    if (BG_URL) { const v = await tryUrl(BG_URL); if (v != null) return v; BG_URL = null; }
    if (Date.now() < BG_NEXT_TRY) return null;                // backoff after a total failure
    for (const u of BG_CANDIDATES) { const v = await tryUrl(u); if (v != null) { BG_URL = u; return v; } }
    BG_NEXT_TRY = Date.now() + 86_400_000;                    // all failed → retry in 24h (protect the 15/day budget)
    return null;
  });
}

// ② ON-CHAIN — netflow + smart-money proxy (Coinglass); mvrvZ/nupl (Glassnode)
async function onchain(syms) {
  return cached('onchain:' + syms.join(','), 600_000, async () => {
    const result = {};
    await Promise.all(syms.map(async sym => {
      const o = {};
      if (KEYS.coinglass) {
        const hdr = { headers: { 'CG-API-KEY': KEYS.coinglass, accept: 'application/json' } };
        const bal = await j(`${CG}/api/exchange/balance/chart?symbol=${sym}`, hdr);
        const pts = bal && bal.data;
        if (Array.isArray(pts) && pts.length > 1) {
          const last = pts[pts.length - 1], prev = pts[pts.length - 2];
          o.netflow = Math.round(parseFloat(last.value ?? last.balance ?? 0) - parseFloat(prev.value ?? prev.balance ?? 0));
        }
        const ratio = await j(`${CG}/api/futures/top-long-short-account-ratio?symbol=${sym}&interval=1h&limit=1`, hdr);
        const rrow = ratio && ratio.data && ratio.data[ratio.data.length - 1];
        const longPct = rrow && parseFloat(rrow.longAccount ?? rrow.long_account ?? 0);
        if (longPct) o.smartMoney = Math.max(0, Math.min(1, longPct > 1 ? longPct / 100 : longPct));
      }
      if (KEYS.glassnode) {
        // Auth via X-Api-Key header — keeps the key out of URLs/logs.
        // Asset code must be lowercase (a=btc). Metrics that the key's tier
        // can't access return 401/403 → j() yields null → field simply omitted.
        const g = m => j(`https://api.glassnode.com/v1/metrics/${m}?a=${sym.toLowerCase()}&i=24h`,
          { headers: { 'X-Api-Key': KEYS.glassnode } });
        const mvrv = await g('market/mvrv_z_score');
        if (Array.isArray(mvrv) && mvrv.length) o.mvrvZ = mvrv[mvrv.length - 1].v;
        const nupl = await g('indicators/net_unrealized_profit_loss');
        if (Array.isArray(nupl) && nupl.length) o.nupl = nupl[nupl.length - 1].v;
      }
      // Free BTC-only MVRV-Z fallback (BGeometrics) when Glassnode didn't supply it.
      if (sym === 'BTC' && o.mvrvZ == null) {
        const z = await btcMvrvZ();
        if (z != null) o.mvrvZ = z;
      }
      result[sym] = o;
    }));
    return result;
  });
}

// ③ SOCIAL — galaxy/sentiment (LunarCrush) or social volume (Santiment)
async function social(syms) {
  return cached('social:' + syms.join(','), 300_000, async () => {
    const result = {};
    await Promise.all(syms.map(async sym => {
      const o = {};
      if (KEYS.lunarcrush) {
        const topic = LC_TOPIC[sym] || sym.toLowerCase();
        const d = await j(`https://lunarcrush.com/api4/public/topic/${topic}/v1`,
          { headers: { Authorization: 'Bearer ' + KEYS.lunarcrush } });
        const t = d && d.data;
        if (t) {
          if (t.galaxy_score != null) o.galaxyScore = Math.round(t.galaxy_score);
          if (t.sentiment    != null) o.tieScore    = +(t.sentiment / 100).toFixed(2);
          if (t.interactions_24h != null || t.num_posts != null)
            o.socialVol = Math.round((t.interactions_24h || t.num_posts || 0) / 1000);
        }
      }
      if (o.socialVol == null && KEYS.santiment) {
        const slug = LC_TOPIC[sym] || sym.toLowerCase();
        const q = `{ getMetric(metric:"social_volume_total"){ timeseriesData(slug:"${slug}", from:"utc_now-1d", to:"utc_now", interval:"1d"){ value } } }`;
        const d = await j('https://api.santiment.net/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Apikey ' + KEYS.santiment },
          body: JSON.stringify({ query: q }) });
        const arr = d && d.data && d.data.getMetric && d.data.getMetric.timeseriesData;
        if (arr && arr.length) o.socialVol = Math.round(arr[arr.length - 1].value);
      }
      result[sym] = o;
    }));
    return result;
  });
}

// ④ MACRO — Fear&Greed + BTC dominance (free, no key)
async function macro() {
  return cached('macro', 600_000, async () => {
    const o = { macro: {} };
    const fng = await j('https://api.alternative.me/fng/?limit=1');
    if (fng && fng.data && fng.data[0]) o.fearGreed = parseInt(fng.data[0].value, 10);
    const gk = KEYS.coingecko ? `?x_cg_demo_api_key=${KEYS.coingecko}` : '';
    const glob = await j('https://api.coingecko.com/api/v3/global' + gk);
    const dom = glob && glob.data && glob.data.market_cap_percentage && glob.data.market_cap_percentage.btc;
    if (dom != null) o.btcDom = +dom.toFixed(1);
    o.macro.rates = process.env.MACRO_RATES || 'NEUTRAL';
    return o;
  });
}

// ---- dispatcher: returns TRUE if it owns the request ----
module.exports = function handleNexusData(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;   // let OPTIONS/POST fall through
  let pathname, sp, origin = req.headers.origin;
  try { const u = new URL(req.url, 'http://x'); pathname = u.pathname; sp = u.searchParams; }
  catch (e) { return false; }
  if (pathname !== '/ping' && !pathname.startsWith('/data/')) return false;

  // keep-alive — zero upstream work
  if (pathname === '/ping') {
    res.writeHead(200, { ...corsHeaders(origin), 'Content-Type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
    return true;
  }

  (async () => {
    try {
      if (pathname === '/data/derivs')      return sendJSON(res, origin, await derivs(parseSyms(sp)));
      if (pathname === '/data/onchain')     return sendJSON(res, origin, await onchain(parseSyms(sp)));
      if (pathname === '/data/social')      return sendJSON(res, origin, await social(parseSyms(sp)));
      if (pathname === '/data/macro')       return sendJSON(res, origin, await macro());
      if (pathname === '/data/health')      return sendJSON(res, origin, {
        status: 'ok',
        keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, !!v])),
        cached: [...cache.keys()],
        time: new Date().toISOString(),
      });
      sendJSON(res, origin, { error: 'Not Found', hint: 'try /data/macro' }, 404);
    } catch (err) {
      sendJSON(res, origin, { error: 'data route error', detail: String(err && err.message || err) }, 500);
    }
  })();
  return true;
};

// startup banner (printed once at require time)
{
  const active = Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k);
  console.log('[nexus-data] routes ready: /ping /data/derivs /data/onchain /data/social /data/macro /data/health');
  console.log('[nexus-data] vendor keys present:', active.join(', ') || 'none (free sources only)');
}
