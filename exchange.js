// exchange.js — signed Binance USDⓈ-M Futures REST. Node signs with the secret
// (never exposed to the browser). DRY_RUN logs intended orders without sending.
const crypto = require('crypto');
const cfg = require('./config');
const BASE = cfg.TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

function sign(qs){ return crypto.createHmac('sha256', cfg.API_SECRET).update(qs).digest('hex'); }
async function signed(path, method, params={}){
  const q=new URLSearchParams({...params, timestamp:Date.now(), recvWindow:5000}).toString();
  const url=`${BASE}${path}?${q}&signature=${sign(q)}`;
  const r=await fetch(url,{method,headers:{'X-MBX-APIKEY':cfg.API_KEY},signal:AbortSignal.timeout(8000)});
  return r.json();
}
async function pub(path, params={}){
  const q=new URLSearchParams(params).toString();
  const r=await fetch(`${BASE}${path}${q?`?${q}`:''}`,{signal:AbortSignal.timeout(8000)});
  return r.json();
}

// Place a market entry (+ round qty to the symbol step in a fuller build).
async function marketOrder(sym, side, qty, log){
  if(cfg.DRY_RUN){ log(`[DRY_RUN] ${side} ${qty} ${sym}USDT MARKET`); return {dryRun:true,orderId:`dry-${Date.now()}`}; }
  return signed('/fapi/v1/order','POST',{symbol:sym+'USDT',side,type:'MARKET',quantity:qty});
}
async function reduceClose(sym, dir, qty, log){
  const side=dir==='LONG'?'SELL':'BUY';
  if(cfg.DRY_RUN){ log(`[DRY_RUN] CLOSE ${side} ${qty} ${sym}USDT reduceOnly`); return {dryRun:true}; }
  return signed('/fapi/v1/order','POST',{symbol:sym+'USDT',side,type:'MARKET',quantity:qty,reduceOnly:'true'});
}
async function stopMarket(sym, dir, qty, stopPrice, log){
  const side=dir==='LONG'?'SELL':'BUY';
  if(cfg.DRY_RUN){ log(`[DRY_RUN] STOP_MARKET ${side} ${qty} ${sym}USDT @${stopPrice}`); return {dryRun:true}; }
  return signed('/fapi/v1/order','POST',{symbol:sym+'USDT',side,type:'STOP_MARKET',stopPrice,closePosition:'true'});
}
async function cancelAll(sym){ if(cfg.DRY_RUN)return {dryRun:true}; return signed('/fapi/v1/allOpenOrders','DELETE',{symbol:sym+'USDT'}); }
async function account(){ if(!cfg.API_KEY)return null; return signed('/fapi/v2/account','GET'); }
async function funding(sym){ const r=await pub('/fapi/v1/premiumIndex',{symbol:sym+'USDT'}); return r&&r.lastFundingRate!=null?parseFloat(r.lastFundingRate)*100:null; }

module.exports = { marketOrder, reduceClose, stopMarket, cancelAll, account, funding, pub, BASE };
