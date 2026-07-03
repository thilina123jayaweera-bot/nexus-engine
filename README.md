# NEXUS Server-Side Engine — headless 24/7, browser as viewer

This is the Option-2 migration: the decision loop runs in Node (on Render, always-on),
so trading continues when your phone is locked, the tab is closed, or the browser is
backgrounded. The dashboard becomes a **viewer** that polls `/engine/state`.

## ⚠️ Read first — safety
- Ships **DRY_RUN=true** (logs intended orders, places none) and **TESTNET=true**.
- Ships **AUTO_MODE=false** — you must enable it explicitly.
- This is a *foundation*: the core decision logic is ported faithfully, but you MUST
  run it on testnet in DRY_RUN, watch the logs, and confirm behaviour before trusting
  it with anything real. Do not flip DRY_RUN=false until you've validated on testnet.

## What's ported vs staged
**Ported & running:** market-data WS ingestion, span-based RSI + bubble, BTC regime
(CORR), funding + Fear&Greed, the 4-bucket dualScore, applyFilters (incl. all the
guards we added: live-data, cooldown, soft-thresholding, regime blocks), computeEntrySize
(Kelly × risk × regime × small-cap cap), the evalTrade exit ladder, risk guards
(AUTO stays on; entries pause & auto-resume), idempotent close, server-side STOP_MARKET,
state persistence, viewer API, **live-data enrichment** (`datafeed.js` pulls your
`/data/*` routes into TK each cycle so decisions use real derivs/on-chain/social).
**Staged (add incrementally toward full parity):** RL/calibration learning, Phase-19
micro-signals, per-symbol qty precision rounding, pyramid adds.

## Live data (datafeed.js)
Each eval cycle the engine calls its own `/data/derivs|onchain|social|markets|macro`
routes over localhost and merges the results into TK. **Drop your `nexus-data-routes.js`
into this folder** (and set the vendor keys in env — same ones as the browser) so the
routes are mounted; otherwise TK stays on seeded defaults (fine for a first dry-run, but
you want live data before trusting decisions). Mapping is defensive — a missing route or
field just leaves the prior value.

## Viewer (viewer.html)
A standalone read-only dashboard. Host it anywhere (or open locally), enter your engine
URL, and it polls `/engine/state` every 4s to show equity, open/closed trades, regime,
and the live log — plus AUTO on/off and Flatten buttons via `/engine/control`. **It never
trades**, so running it instead of the old browser engine eliminates any double-order
risk. (You can also fold this into `index.html` later; the standalone page is the safe
starting point.)

## Architecture
```
Binance WS/REST ─► marketdata.js ─► TK/LP/CORR/MKT
                                      │
        engine.js loop:  every 5m scanAndEnter()   every 5s manageExits()
                                      │                       │
                              decision.js (pure)        exchange.js (signed, testnet, DRY_RUN)
                                      │                       │
                                   state.js  ◄──── persists trades/portfolio ────┘
                                      │
        server.js: /engine/state (read) + /engine/control + /data/* + /ping
                                      │
                          index.html VIEWER (polls /engine/state, renders)
```

## Setup (testnet)
1. `npm install`
2. Env (Render → Environment, or a local `.env`):
   - `BINANCE_KEY`, `BINANCE_SECRET`  ← **testnet** futures keys (testnet.binancefuture.com)
   - `DRY_RUN=true` `TESTNET=true` `AUTO_MODE=false` (defaults)
   - optional: `CAPITAL`, `MAX_POS`, `LEVERAGE`, `STOP_LOSS`, `UNIVERSE_SIZE`
3. `npm start` → watch the log: universe load, `market WS connected`, then scans.
4. Enable dry-run trading decisions: `GET /engine/control?cmd=auto-on`
   (still DRY_RUN — it will *log* ENTER/CLOSE without sending orders).
5. Watch `/engine/state` and the console. Confirm entries/exits look right.

## Going live (only after testnet validation)
1. Confirm testnet DRY_RUN behaviour over several sessions.
2. `DRY_RUN=false` (still TESTNET) → real testnet orders. Verify fills + stops appear on testnet.
3. Only then consider `TESTNET=false` with **mainnet keys** and a small `CAPITAL`.
   Controls: `?cmd=auto-off` (manual stop), `?cmd=flatten` (close all), `?cmd=dryrun-on`.

## Viewer wiring (index.html)
Point the dashboard at the engine as read-only:
- Poll `GET {proxy}/engine/state` every few seconds; render `portfolio`, `open`, `closed`,
  `regime`, `macro`, `log`. Disable the browser's own decision loops (it must not also trade).
- Controls call `{proxy}/engine/control?cmd=auto-on|auto-off|flatten|dryrun-off`.

## Notes
- The engine holds your API secret server-side only — never send it to the browser.
- One decision-maker rule: when the server engine runs AUTO, the browser must be viewer-only,
  or you'll get double orders.
