// server.js — http entry. Keeps the existing Binance proxy relay + /data/* routes,
// and adds the engine: /engine/state (read-only snapshot for the browser viewer) and
// /engine/control?cmd=... The browser no longer decides — it just renders this state.
const http = require('http');
const cfg = require('./config');
const engine = require('./engine');
const { S } = require('./state');
require('./state').load();

let dataRoutes=null; try{ dataRoutes=require('./nexus-data-routes'); }catch(e){}

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url,'http://x'); const p=url.pathname;
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
  const json=(o,code=200)=>{res.writeHead(code,{'Content-Type':'application/json',...cors});res.end(JSON.stringify(o));};

  // read-only snapshot for the viewer
  if(p==='/engine/state'){
    return json({ runtime:S.runtime, autoMode:S.autoMode, portfolio:S.portfolio,
      open:S.trades.filter(t=>t.status!=='CLOSED'), closed:S.closedTrades.slice(0,50),
      regime:require('./marketdata').CORR, macro:require('./marketdata').MKT, log:(S._log||[]).slice(0,60) });
  }
  // controls
  if(p==='/engine/control'){
    const cmd=url.searchParams.get('cmd');
    if(cmd==='auto-on')engine.setAuto(true);
    else if(cmd==='auto-off')engine.setAuto(false);
    else if(cmd==='dryrun-on')engine.setDryRun(true);
    else if(cmd==='dryrun-off')engine.setDryRun(false);
    else if(cmd==='flatten')await engine.closeAll('MANUAL');
    else return json({error:'unknown cmd'},400);
    return json({ok:true,autoMode:S.autoMode,dryRun:cfg.DRY_RUN});
  }
  // delegate /ping and /data/* to the existing routes module if present
  if(dataRoutes && (p==='/ping'||p.startsWith('/data/'))){
    if(await dataRoutes(req,res,url))return;
  }
  // (existing Binance /proxy relay would remain here in your current server.js)
  json({service:'nexus-engine',endpoints:['/engine/state','/engine/control','/data/*','/ping']});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{ console.log(`nexus-engine http on :${PORT}`); engine.start(); });
