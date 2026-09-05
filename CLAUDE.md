# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A crypto trading bot (personal/single-account, not a multi-tenant service) with a web dashboard
showing available strategies, whether each is running, and its transactions/statistics. Trades
execute against Binance. A Telegram bot layer ("chatops") allows commands and reports.

**This is a living document.** Update it after finishing each phase below: flip its status,
record the real commands/structure that resulted, and note any deviation from the plan and why.
Do not let it drift out of sync with what's actually in the repo.

**Commit after each phase.** Once a phase's work (and its `CLAUDE.md` update) is done, `git add`
the new/changed files and create a commit describing what that phase delivered — one commit per
phase, not one giant commit at the end. Review what's staged before committing (nothing from
`node_modules`, no secrets/`.env` files).

## Architecture (agreed, see phases for build order)

Three independently-deployable apps, sharing MongoDB (system of record) and Redis (live
pub/sub) but never each other's process:

- **Engine** (`apps/engine`) — long-running Node/TS process. One supervised worker per
  strategy (isolated: a crash/error in one restarts that worker, not the others). Each worker's
  trade decision passes through a **Risk Manager** (position/exposure limits, kill switch) and a
  **Capital Ledger** (reserves/releases funds per strategy so two strategies can't both spend the
  same balance) before an **Order Service** places it. The Order Service writes the order
  *intent* to Mongo before calling Binance (outbox pattern) and uses idempotent client order IDs,
  so a crash mid-order can't double-place or lose track of it on restart. A **reconciliation job**
  runs on a schedule, diffs Mongo's view of the account against Binance's actual balances/open
  orders, and alerts loudly on mismatch.
- **UI** (`apps/ui`, the existing Next.js app — currently at `src/`, moves under `apps/ui` in
  Phase 0) — reads Mongo for history/stats, subscribes to Redis for live strategy status and
  trade ticks, and exposes controls (pause/resume/kill switch) that call the Engine's internal
  authenticated API rather than touching Mongo/Binance directly.
- **Chatops** (`apps/chatops`) — Telegram bot. Built in two stages: first a fixed command set
  (`/status`, `/pause`, `/resume`, `/report`) calling the Engine's internal API — no LLM. An
  MCP/natural-language layer is added later on top of that, restricted to an explicit allow-list
  of actions, with a confirmation step required for anything state-changing. It never talks to
  Binance directly.

**Strategy code is exchange-agnostic**: strategies are written against a `Broker` interface
(`decide(marketData) -> intended orders`), with a `PaperBroker` (Phase 2) and `BinanceBroker`
(Phase 3) both implementing it — so the same strategy code runs in backtest, paper, and live
without modification.

### Non-negotiable policies

- **MCP/LLM is never in the trade execution path.** Binance orders are placed only via the
  official Binance SDK inside Engine's own reviewed code. Chatops may *read* state and issue a
  small set of pre-approved control commands; it never decides trades.
- **No official Binance MCP server exists** (verified 2026-09) — only unofficial/community ones,
  none vetted. None are installed. If one is ever added, it's for interactive dev-time queries
  only (read-only Binance API key), never wired into production execution, and only after reading
  its source. See MCP servers section below.
- **Money fields are always `Decimal128`, never floats.**
- Every strategy is promoted through lifecycle states, not switched straight to live-with-real-money:
  draft → backtested → paper trading → live (small capital) → live (full) → paused → retired.

### Mongo collections (introduced in Phase 1)

`strategies`, `orders` (intents + fills), `trades` (closed round-trips), `equity_snapshots`,
`capital_allocations`, `audit_log`, `commands` (chatops-issued control actions).

### MCP servers configured

- `mongodb` — official `mongodb-js/mongodb-mcp-server`, pointed at a local dev connection string
  (`mongodb://localhost:27017/trade-bot-dev`). Dev-time schema/query assistance only; the
  running Engine/UI talk to Mongo through the normal driver, not through this MCP server.

## Build phases

- [x] **Phase 0 — Repo & infra scaffolding.** Done 2026-09-05. npm workspaces at the repo root
  (`apps/*`, `packages/*`); `apps/ui` is the pre-existing Next.js app (moved from `src/`, package
  renamed `@trade-bot/ui`); `apps/engine` and `apps/chatops` are placeholder Node/TS services
  (`tsx watch` for dev, `tsc` build, package names `@trade-bot/engine` / `@trade-bot/chatops`)
  with just a startup log line — no business logic yet, that starts Phase 2/5; `packages/shared`
  is an empty placeholder module reserved for the Phase 2 `Broker`/`Strategy` types. Root
  `docker-compose.yml` now defines `mongodb` (7.0, port 27017) and `redis` (7-alpine, port 6379)
  for local dev — no auth, dev-only, per the documented policy of hardening before real capital
  (Phase 6). Verified: all three new packages typecheck clean, `engine`/`chatops` entrypoints run,
  `apps/ui` still lints clean after the move, and `docker compose config` validates the compose
  file syntactically (Docker Desktop wasn't running to actually start the containers — run
  `docker compose up -d` once it is).
  **Note for later:** when `apps/ui` starts importing real code (not just types) from
  `@trade-bot/shared`, add `transpilePackages: ["@trade-bot/shared"]` to
  `apps/ui/next.config.ts` — Next.js doesn't transpile TS in workspace packages by default.
- [x] **Phase 1 — Data layer.** Done 2026-09-05. All 7 collections modeled as TypeScript
  interfaces in `packages/shared/src/models/` (`Strategy`, `Order`, `Trade`, `EquitySnapshot`,
  `CapitalLedgerEntry`, `AuditLogEntry`, `ChatopsCommand`), all money fields typed as `Decimal128`.
  `packages/shared/src/money.ts` has `toDecimal128`/`decimal128ToNumber` helpers —
  `toDecimal128` only accepts a string, deliberately, so a caller can't launder a float through it.
  `packages/shared/src/db/` has `connection.ts` (`connectMongo`/`closeMongo`), `collections.ts`
  (typed collection accessors + `COLLECTION_NAMES`), and `indexes.ts` (`ensureIndexes`, idempotent
  — safe to call on every app startup). Notable indexes: unique `clientOrderId` on `orders`
  (enforces order idempotency at the DB level) and unique `slug` on `strategies`.
  Verified live: `docker compose up -d`, then `npm run verify --workspace=@trade-bot/shared`
  connected to the dev Mongo, created all indexes, and confirmed all 7 collections exist.
  Root `.env.example` added (`MONGODB_URI`, `REDIS_URL` for Phase 4).
- [x] **Phase 2 — Engine core, paper trading only.** Done 2026-09-05. All in `apps/engine/src/`:
  - `broker/types.ts` — the `Broker` interface (`placeOrder`) that `PaperBroker` and Phase 3's
    `BinanceBroker` both implement; strategy/runner code never knows which one it's talking to.
  - `broker/paperBroker.ts` — fills instantly and completely at the last price fed via
    `setPrice()`, with a simulated 0.1% fee. No partial fills/slippage/latency modeling — a known
    simplification, flagged in its own comment (paper results will look better than live).
  - `risk/riskManager.ts` — `RiskManager.checkCanEnter` blocks on kill switch or a
    paused/retired lifecycle state. `maxConcurrentPositions`/`maxDrawdownPct` enforcement is
    deferred to Phase 6.
  - `risk/capitalLedger.ts` — `CapitalLedger` (reserve/release against an append-only ledger in
    `capital_allocations`). Documented known limitation: read-last-entry-then-insert is a
    check-then-act race across *concurrent* reservations for the same strategy — fine for one
    strategy at a time, needs an atomic update or Mongo transaction before running several
    concurrently.
  - `strategy/types.ts` + `strategy/movingAverageCross.ts` — the `StrategyAlgorithm` interface
    (named that, not `Strategy`, to stay distinct from `@trade-bot/shared`'s `Strategy` document)
    and a trivial 5/20-period SMA-cross implementation. Spot-only: no SHORT signal.
  - `marketData/binancePublic.ts` — fetches real historical candles from Binance's public,
    unauthenticated klines endpoint (read-only market data, no API key, no trading capability —
    distinct from the Phase 3 `BinanceBroker` concern). `marketData/syntheticCandles.ts` is the
    fallback used only if that request fails, so the pipeline still runs without network access.
  - `strategyRunner.ts` — `StrategyRunner.onCandle()` wires it all together: decide → risk check →
    capital reserve → broker order → `orders`/`trades`/`audit_log` writes. Known limitation:
    position state is in-memory only, lost on restart — rebuilding it from Mongo/exchange state on
    startup is a Phase 3 reconciliation concern.
  - `index.ts` — the Phase 2 entrypoint: loads 200 real 1h BTCUSDT candles, runs them through one
    `MovingAverageCrossStrategy` on `PaperBroker`, prints the closed trades.
  - `packages/shared/src/money.ts` gained `toDecimalJs`/`fromDecimalJs` (decimal.js round-trip) —
    `Decimal128` has no arithmetic methods, so any money/quantity math goes through decimal.js,
    never plain JS numbers.
  **Verified live** (not just typechecked): `npx tsx src/index.ts` against the real Docker Mongo
  pulled 200 real BTCUSDT hourly candles from Binance's public API and produced 6 closed trades
  with compounding position sizing. Confirmed in Mongo: 13 orders all `FILLED`, 13 capital-ledger
  entries (reserve on entry / release on exit, correctly netting to 0 free capital while the last
  position was still open), and 39 audit-log entries (`DECISION`/`ORDER_INTENT`/`ORDER_FILLED` ×
  13). `npm run build --workspace=@trade-bot/engine` (real `tsc` compile, not just `--noEmit`)
  also passes.
- [x] **Phase 3 — Real exchange integration (spot).** Done 2026-09-05, verified live.
  - `broker/binanceBroker.ts` — `BinanceBroker` using the official `@binance/spot` connector
    (`github.com/binance/binance-connector-js`, confirmed via its npm `repository` field before
    installing). MARKET orders only, matching what `StrategyRunner` issues; a market order's
    synchronous REST response already contains its fills, so this doesn't need the user-data
    WebSocket yet — that becomes necessary once LIMIT orders are introduced. Fetches and caches
    each symbol's real `LOT_SIZE` step size via `exchangeInfo` and rounds the order quantity to it
    before sending — addresses the "Binance rejects wrong-precision quantities" failure mode
    flagged earlier. Maps Binance's order-status strings onto our internal `OrderStatus` union
    (`NEW`→`SUBMITTED`, unrecognized statuses→`FAILED` rather than throwing).
  - `reconciliation/reconcile.ts` — read-only: diffs Mongo's open orders (`SUBMITTED`/
    `PARTIALLY_FILLED`) against Binance's `getOpenOrders()` in both directions, and sums each
    active strategy's free capital-ledger balance per asset against the exchange's real
    `getAccount()` free balance, flagging only if the ledger claims *more* free capital than
    actually exists (the ledger claiming less is expected and not flagged). Mismatches are written
    to `audit_log` as `RECONCILIATION_MISMATCH`. Never cancels an order or adjusts the ledger.
  - `scripts/testnetSmokeTest.ts` — manual verification script
    (`npm run testnet-smoke --workspace=@trade-bot/engine`): places one small real MARKET order on
    Binance's spot testnet, then runs `reconcile()`. Hardcodes `useTestnet: true` — never point it
    at mainnet. Requires `BINANCE_API_KEY`/`BINANCE_API_SECRET` (testnet keys from
    testnet.binance.vision — fake funds, zero financial risk) in `.env` or the shell; refuses to
    run without them rather than silently no-op'ing.
  - The order-intent outbox and idempotent `clientOrderId` from CLAUDE.md's Engine section were
    already implemented in `StrategyRunner` back in Phase 2 (broker-agnostic by design) — nothing
    Binance-specific was needed there.
  - Typechecks clean (`npm run typecheck --workspace=@trade-bot/engine`), builds clean via real
    `tsc` (not just `--noEmit`), and the Phase 2 paper-trading run was re-verified unaffected
    (identical 6-trade output against the same real BTCUSDT candles).
  - **Verified live** 2026-09-05: `testnet-smoke` placed a real MARKET BUY (0.001 BTCUSDT) on
    Binance's spot testnet — filled instantly (order `12473053`, price ~79700 USDT, 0.0000001 BTC
    commission), and `reconcile()` ran against the real account and found 0 mismatches. Two real
    debugging notes worth keeping: (1) the dev machine's clock was ~4.8s ahead of Binance's server
    time, which the connector's hardcoded `Date.now()` timestamp has no override for — fixed via
    `w32tm /resync` (needs an elevated shell); (2) a real-account API key (even trading-only, no
    withdrawal) does **not** authenticate against the testnet base URL — testnet requires its own
    key generated at testnet.binance.vision itself, entirely separate account system.
  - **Scope note**: this phase was built spot-only, matching the original plan. The user has since
    said the actual target is **futures**, which changes the broker, schema, and risk model
    materially — see the new Phase 3b below rather than extending this checklist entry.

- [x] **Phase 3b — Futures pivot.** Done 2026-09-05, verified live against Binance's futures
  testnet. Binance USDT-M perpetual futures, isolated margin per strategy, one-way position mode
  (account-level setting), per-strategy configurable leverage with a hard system ceiling enforced
  by the Risk Manager. Existing spot code (`BinanceBroker`, spot `reconcile()`) is kept as-is, not
  deleted — futures is additive, not a replacement.
  - Uses the official `@binance/futures-connector`
    (`github.com/binance/binance-futures-connector-node`) — confirmed official via npm, but early
    (v0.1.7 vs `@binance/spot`'s v32) and **ships no TypeScript types at all**. Ambient types for
    just the methods we use live in `broker/futuresConnectorTypes.d.ts`; every field read off a
    response in `binanceFuturesBroker.ts` is validated at runtime, not trusted from a vendor
    contract, because there isn't one.
  - Schema (`packages/shared`): `StrategySignal` gains `ENTER_SHORT`/`EXIT_SHORT`.
    `StrategyPositionState` gains `side: "LONG" | "SHORT" | null`. `RiskLimits.maxLeverage`
    (per-strategy, enforced by `RiskManager` against a hard ceiling — constructor arg, default
    20x — so a misconfigured strategy can't exceed it regardless of what its own config says).
    `Strategy.marginMode` (`"ISOLATED" | "CROSSED"`, futures-only). `BrokerKind` gains
    `"binance-futures"` (`"binance"` kept its original name for the already-verified spot code, not
    renamed to `"binance-spot"` — nothing branches on the literal string, so no risk either way).
    `Order` gains optional `reduceOnly`. `Trade` gains `leverage` and `fundingFeesPaid` (funding-fee
    computation itself is **not implemented** — the field exists so the shape is ready, but reads
    as 0 always; don't mistake that for "no funding cost," it means "not tracked yet").
  - `broker/binanceFuturesBroker.ts` — `BinanceFuturesBroker`, same `Broker` interface as
    `PaperBroker`/`BinanceBroker`. `configureOneWayPositionMode()` (account-wide, call once) and
    `configureSymbol(symbol, leverage, marginMode)` (per-symbol, call before trading it) — both
    treat Binance's "already in that mode" error codes (-4059/-4046) as success, safe to call every
    strategy start. Unlike spot, a futures order's own response has no fill/commission
    breakdown — `placeOrder` makes one extra signed call (`getAccountTradeList`) to fetch the real
    fills rather than estimating a fee rate.
  - `strategy/movingAverageCross.ts` extended to go both directions. **Found and fixed a real logic
    bug while doing this**: an earlier version returned `EXIT_LONG`/`EXIT_SHORT` on a reversing
    cross, which made `SHORT` structurally unreachable — exiting a `LONG` only ever happened on a
    cross-down, and the next cross is always up (they alternate), so the algorithm could never be
    flat exactly when a cross-down arrived. Fixed by having `ENTER_LONG`/`ENTER_SHORT` mean "be
    long/short after this" — `StrategyRunner.onCandle` now treats that as a flip (exit then
    re-enter) when the opposite side is open, not just "open from flat." Verified live via
    `PaperBroker`: re-ran the demo strategy against the same 200 real BTCUSDT candles and got 6
    LONG + 6 SHORT trades (previously always 6 LONG, 0 SHORT), capital ledger balance never went
    negative, sizing scaled correctly with the strategy's 3x configured leverage (~3x the position
    size of the earlier 1x spot run on the same data).
  - `strategyRunner.ts` — also fixed a smaller pre-existing gap while unifying the long/spot and
    short/leveraged math: the entry order's commission was previously computed and stored but never
    actually subtracted from PnL (only the exit fee was). Now `OpenPosition` tracks `entryFee`, and
    `pnl = realizedPnl - (entryFee + exitFee)` for both sides. `pnlPct` is now % return on margin
    reserved, not on notional — with leverage those differ by roughly the leverage multiple, and
    margin-based ROI is what was actually at risk. Exit price is now the volume-weighted average
    (`cumulativeQuoteQuantity / executedQuantity`) instead of just the first fill's price. All of
    this reduces to the exact Phase 2 spot formulas when leverage is 1, so nothing broke there.
  - `scripts/futuresTestnetSmokeTest.ts` — configures one-way mode + ISOLATED/3x on the test
    symbol, opens a small MARKET long, then closes it with a `reduceOnly` SELL. Hardcodes
    `useTestnet: true`. Run via `npm run futures-testnet-smoke --workspace=@trade-bot/engine`.
  - Known gaps, flagged rather than hidden: liquidation-price/margin-ratio monitoring is deferred
    to Phase 6 — `RiskManager` enforces the leverage ceiling and kill switch/lifecycle checks, not
    live margin health. Futures reconciliation (positions/margin balance, not spot balances) isn't
    built — `reconcile()` still only covers the spot account. Funding fees aren't computed.
  - Typechecks and builds clean across `packages/shared` and `apps/engine`.
  - **Verified live** 2026-09-05: `futures-testnet-smoke` configured one-way mode + ISOLATED/3x on
    BTCUSDT, opened a real MARKET long (0.002 BTC, order `28572075134`), and closed it with a
    `reduceOnly` SELL (order `28572075144`) — both filled with real commission data.
  - **Found and fixed a second real bug during that verification run**: a futures `newOrder`
    response doesn't reliably reflect the fill synchronously the way spot's does — the first live
    run returned `status: "SUBMITTED"`, `executedQuantity: "0.0000"` at the top level *while the
    fills already fetched via `getAccountTradeList` showed it had, in fact, filled* (real price,
    quantity, commission). `placeOrder` now derives `status`/`executedQuantity`/
    `cumulativeQuoteQuantity` from the fetched fills whenever any exist, falling back to the raw
    order response only if fills comes back empty. That fallback path is itself a known remaining
    race-condition gap (if the trade list hasn't caught up yet when queried) — a retry/poll loop
    would close it, not built yet, worth doing before this is trusted with real money.
- [x] **Phase 4 — Live dashboard.** Done 2026-09-05, verified live in a real browser.
  - **The engine became a genuinely long-running process.** Before this it was a one-shot script
    that replayed a fixed candle batch and exited (Phase 2/3b). `apps/engine/src/index.ts` now
    seeds two demo strategies (BTCUSDT + ETHUSDT — proves the dashboard renders a real *list*, not
    one row), stays alive until stopped, and handles SIGINT/SIGTERM cleanly.
  - `marketData/binanceKlineStream.ts` — real live candles via Binance's public kline
    **WebSocket** (`wss://stream.binance.com`), using Node's built-in global `WebSocket` (Node 22+,
    confirmed working here — no extra dependency). Reconnects with exponential backoff (capped
    30s). Known gap: candles missed while disconnected aren't backfilled.
  - `strategy/warmUp.ts` — feeds recent historical candles into a strategy's `decide()` before the
    live stream starts, discarding the signals, purely to prime a rolling window (e.g. the 20-period
    SMA) so the strategy isn't idle for 20 live minutes after every restart.
  - `events/redisPublisher.ts` — `EventPublisher`, fails open (logs a warning, no-ops) if Redis is
    unreachable at startup, so a dashboard-only dependency being down can never take trading down
    with it. Wired into `StrategyRunner`'s existing `audit()` call site — every event that reaches
    `audit_log` reaches the live feed too, nothing to keep in sync separately. `index.ts` also
    publishes a `STATUS` heartbeat every 30s per strategy so "is it running" is visible even between
    trades.
  - `registry.ts` (`StrategyRegistry`) + `controlApi.ts` — the internal HTTP API from CLAUDE.md's
    Engine section, bound to `127.0.0.1` only, gated by a shared-secret bearer token
    (`ENGINE_CONTROL_API_TOKEN`). `GET /status`, `POST /strategies/:slug/{pause,resume,kill,unkill}`.
    Control actions mutate the same `Strategy` object instance `StrategyRunner` already holds a
    reference to (not a copy) — a pause/kill takes effect on the very next candle with no restart,
    because `RiskManager.checkCanEnter` reads those fields fresh every call.
  - `apps/ui` (Next.js dashboard): `app/page.tsx` (strategy list, live via SSE), `app/strategies/
    [slug]/page.tsx` (stats + trade log + controls), `app/api/stream/route.ts` (SSE bridge — one
    Redis subscriber per browser tab, chosen over a separate WebSocket/Socket.io server since a
    Route Handler can stream natively), `app/api/strategies/[slug]/[action]/route.ts` (server-side
    proxy to the Engine's control API — the browser never sees the engine's token or port).
    `lib/stats.ts` computes win rate / profit factor / max drawdown / a Sharpe-*like* ratio
    (explicitly not a proper annualized Sharpe — no consistent return-period assumption exists
    across trades of varying duration).
  - **Three real bugs found and fixed during this phase, in the order hit:**
    1. **Turbopack couldn't resolve `packages/shared`'s internal imports.** They used the
       Node/TS NodeNext convention of writing a `.js` extension for a file that's actually `.ts`
       (valid under `tsc`, resolved fine by `tsx`) — but Turbopack's `transpilePackages` handling
       doesn't resolve that pattern, failing with "module has no exported member" for every single
       export. Fixing `packages/shared` alone (stripping the extensions, switching its tsconfig to
       `moduleResolution: "bundler"`) then broke `apps/engine`'s own typecheck, because without
       TS project references, a single `tsc` invocation resolves *every* file it pulls in —
       including `packages/shared`'s — using the **invoking project's** compiler options, not the
       target file's own tsconfig. Real fix: the whole monorepo (`packages/shared`, `apps/engine`,
       `apps/chatops`) now uses `module: "ESNext"` / `moduleResolution: "bundler"` with
       extensionless relative imports throughout — the one convention `tsc`, `tsx`, and Turbopack
       all agree on. Consequence: `apps/engine`/`apps/chatops`'s `"start"` script now runs via
       `tsx` instead of `node dist/index.js` — plain Node's ESM loader requires explicit
       extensions that a `tsc`-emitted extensionless-import build wouldn't have. A real compiled
       Node-ESM production build is deferred to Phase 6 (no deployment story exists yet anyway);
       `"build": "tsc"` still exists and still catches type errors, its output just isn't run
       directly right now.
    2. **Max drawdown showed a nonsensical "2099.9%."** The formula measured drawdown against the
       strategy's own cumulative-PnL peak starting from 0 — which blows up the moment that peak is
       a tiny positive number early on, since any later loss is enormous *relative to that peak*
       even though it's small relative to real capital. Fixed by anchoring the equity curve at the
       strategy's actual `allocatedCapital` instead of 0, so the denominator is stable and the
       result reads correctly (24.5%, on the real 12-trade demo history) — this is a case that only
       showed up by actually looking at the rendered number, not from typechecking or a unit test.
    3. **The kill-switch button used `window.confirm()`**, a native dialog that blocks the page's
       own event loop (including its SSE listener) for as long as it's open — the wrong trade-off
       for a live trading control, and it also blocks browser-automation testing outright. Replaced
       with an in-page arm-then-confirm pattern (`StrategyControls.tsx`): first click arms for 4s
       and shows "Click again to confirm," second click within that window executes, otherwise it
       disarms. No native dialogs anywhere in the app now (`alert()` calls replaced with inline
       error text too).
  - **Verified live**: engine running as a real background process with both demo strategies
    streaming live 1-minute candles; dashboard loaded in an actual Chrome tab (via claude-in-chrome)
    showing both strategies with live SSE status updates (heartbeat visibly arriving, "STATUS ·
    <time>" updating with no page refresh); clicked into a strategy detail page and confirmed real
    stats/trade log rendering; clicked Pause → confirmed engine state flipped to `paused` (checked
    both in the UI and via direct `GET /status`) and the button flipped to Resume; armed and
    confirmed the kill switch → confirmed `killSwitchEngaged: true` at the engine and reflected on
    both the detail page and the list page; restored both strategies to a clean running state
    afterward. One hydration console warning observed on the list page is a false positive
    (`cz-shortcut-listen` attribute from a browser extension injecting into the DOM before React
    hydrates), not a real defect — noted, not fixed, since there's nothing in this codebase to fix.
- [x] **Phase 5 — Chatops (fixed commands).** Done 2026-09-05, verified live against a real
  Telegram bot. MCP/NL layer on top of this is separate future work, not started.
  - `apps/chatops/src/bot.ts` — `createBot()`, using `telegraf` (long polling, not a webhook — no
    public HTTPS endpoint needed for this). Commands: `/status`, `/pause`, `/resume`, `/kill`,
    `/unkill` (all via the shared `ControlApiClient`, same client `apps/ui`'s proxy route uses —
    see the `packages/shared` refactor below), and `/report <slug>` (reads Mongo directly —
    `strategiesCollection`/`tradesCollection` — and reuses `computeStrategyStats`, also moved to
    `packages/shared` this phase). No LLM/MCP anywhere in this path, per CLAUDE.md's non-negotiable
    policies — chatops only ever calls the same small, fixed action set the dashboard does.
  - **Authorization gate, not optional**: `index.ts` refuses to start at all without at least one
    entry in `TELEGRAM_ALLOWED_CHAT_IDS`. A `bot.use()` middleware checks every incoming message's
    chat ID against that allow-list and silently drops anything else (no reply at all) — a stranger
    who finds the bot token learns nothing about what it does or that a command even exists.
  - **Refactor while building this**: `computeStrategyStats` (was `apps/ui/lib/stats.ts`) and a new
    `ControlApiClient` both moved into `packages/shared`, since both `apps/ui` and `apps/chatops`
    need identical logic — `apps/ui`'s control-API proxy route now uses `ControlApiClient` too
    instead of its own hand-rolled fetch wrapper. One real gotcha hit doing this: `bot.launch()`'s
    returned promise resolves only when the bot *stops* (it's the long-polling loop itself, not a
    one-time connect step) — `index.ts` deliberately does not `await` it, using the `onLaunch`
    callback instead, or the "running" log would only ever print after shutdown.
  - Typechecks clean across `packages/shared`, `apps/engine` (re-verified after the shared
    refactor), and `apps/chatops`; `apps/ui` re-lints/rebuilds clean too.
  - **Verified live** 2026-09-05: bot connected to Telegram (long polling) and authorized-chat
    replies confirmed for `/status` (listed both demo strategies), `/report ma-cross-demo` (stats
    from Mongo), and `/pause ma-cross-demo-eth` — the last one confirmed not just by the bot's
    reply but by checking `GET /status` on the engine directly and seeing `lifecycleState:
    "paused"` persisted, then resumed afterward to restore a clean running state. One process note:
    a status check run immediately after sending `/pause` still showed the old state — Telegram's
    long-polling delivery isn't instantaneous, a re-check a few seconds later showed it applied
    correctly. Not a bug, just latency worth expecting when scripting checks against this path.
- [~] **Phase 6 — Hardening before real capital.** Code complete and verified live 2026-09-05 for
  everything except the soak test (see below — that one needs real elapsed time, not something a
  session can complete). Rather than trying to close every gap flagged in earlier phases, this
  pass targeted what was actually load-bearing for safety, prioritizing one thing found while
  reviewing for this phase that was worse than it looked: `reconcile()` had existed since Phase 3
  but **nothing ever called it automatically** — it only ran from the manual smoke-test scripts.
  - **`risk/drawdownBreaker.ts`** — `checkDrawdownBreaker()` enforces `riskLimits.maxDrawdownPct`,
    a field that's existed on the schema since Phase 1 and was never actually enforced until now.
    Called from `StrategyRunner.exitPosition` after every closed trade; reuses
    `computeStrategyStats` rather than recomputing drawdown separately. Mutates the same `Strategy`
    object `StrategyRegistry`/`StrategyRunner` already share (established pattern from Phase 4), so
    a breach takes effect immediately, no restart.
  - **A real concurrency bug found and fixed while reviewing `StrategyRunner`**: nothing enforced
    that two candle events for the same strategy couldn't both start executing an order action
    before the first finished. If a candle arrived while a prior `enterPosition` was still
    mid-await (broker/DB calls), `positionState` would be computed from `this.openPosition`, which
    isn't set until that prior call completes — so the new candle could see "flat" and attempt to
    enter again concurrently, double-spending the capital ledger and risking a duplicate order.
    Not hit live yet (1-minute candles rarely close faster than a broker call returns), but real.
    Fixed with a `busy` guard around the order-execution dispatch — deliberately *not* around
    `algorithm.decide()` itself, since the algorithm's indicator state (e.g. the moving-average
    window) must still update every candle; only the resulting action is guarded, and an
    overlapping signal is dropped (logged) rather than queued.
  - **Scheduled spot reconciliation** — `apps/engine/src/index.ts` now runs `reconcile()` on an
    interval (`RECONCILE_INTERVAL_MS`, default 5 min) whenever `BINANCE_API_KEY`/`SECRET` are
    present, defaulting to testnet (`BINANCE_USE_TESTNET` must be explicitly set to `"false"` to
    ever point it at a real account — safe-by-default, matching the pattern used throughout).
    Skips cleanly with a clear log line when no credentials are configured (paper-only mode, the
    current default). Futures reconciliation still isn't built — `reconcile()` only covers the
    spot account, unchanged gap from Phase 3b.
  - **Proactive chatops alerting** — `apps/chatops/src/alerts.ts` (`startAlertWatcher`) polls
    `audit_log` every 30s for new `KILL_SWITCH`/`RECONCILIATION_MISMATCH` entries and pushes them
    to every allow-listed chat unprompted. Chatops is the only service holding Telegram
    credentials, so it's the natural home for this rather than having the engine reach out to
    Telegram directly.
  - **`BinanceFuturesBroker` fill-race gap (flagged in Phase 3b) closed**: `getFillsForOrder` now
    retries up to 3 times (300ms apart) before falling back to the order response's own
    (potentially stale) data.
  - **`riskLimits.maxConcurrentPositions`** is not separately enforced — deliberately. Every
    strategy can only ever hold one position at a time by construction (`enterPosition` requires
    `!this.openPosition`), so the field is currently unenforceable-because-unreachable rather than
    unenforced; building a check for a state that can't occur would be dead code. Revisit if a
    strategy is ever built that can hold multiple simultaneous positions.
  - **Verified live, not just typechecked**: restarted the engine and confirmed the
    "spot reconciliation scheduled every 5 min (testnet: true)" log line (real spot testnet keys
    were already in `.env` from Phase 3). Then, since waiting for the live market to organically
    breach a drawdown limit isn't practical to verify synchronously, called the real
    `checkDrawdownBreaker()` directly against `ma-cross-demo`'s actual trade history (temporarily
    lowering its `maxDrawdownPct` to 1, below its known real ~24.5% drawdown from Phase 4) and
    confirmed: the function returned `true`, `killSwitchEngaged` flipped and persisted to Mongo,
    and a `KILL_SWITCH` audit_log entry (mirroring exactly what `StrategyRunner` writes) triggered
    chatops's alert watcher — confirmed by the operator receiving an **unprompted** Telegram
    message within the 30s poll window. Original values restored afterward. One operational note
    hit restarting chatops: Telegram returned a transient `409 Conflict` ("terminated by other
    getUpdates request") for about 15 seconds after the previous instance stopped — not a real
    competing process (checked via `Get-CimInstance Win32_Process`, nothing else was running), just
    Telegram's backend not having released the prior long-poll session yet. Waiting it out and
    retrying resolved it; not a code bug.
  - Typechecks and builds clean across the whole workspace after these changes.
  - **Security review checklist** (procedural — mostly human judgment about real exchange account
    settings, not something to verify by reading code):
    - [x] No real-account API keys have ever been placed in this project's `.env` — only spot and
      futures **testnet** keys, confirmed by the user (see Phase 3/3b transcripts).
    - [ ] Before any real-account key is ever added: confirm it is trading-only, **no withdrawal
      permission**, and disable any exchange permission (e.g. futures, if not used) beyond what
      the account actually trades — flagged once already in Phase 3b regarding an unrelated
      real-account key, worth re-checking whenever a new key is issued.
    - [ ] IP-restrict any real-account API key to the machine/server that will actually run the
      engine, if the exchange supports it.
    - [ ] Replace `ENGINE_CONTROL_API_TOKEN`'s dev-only placeholder with a real generated secret
      before running anywhere other than local dev.
    - [x] `TELEGRAM_ALLOWED_CHAT_IDS` is scoped to the operator only, confirmed via the Phase 5/6
      live verification (unauthorized messages are silently dropped, never processed).
    - [x] `.env` is gitignored and was never committed — verified at every phase's commit review
      in this document.
    - [ ] Before promoting any strategy past `paper`: do it deliberately one step at a time
      (`paper` → `live_small` → `live_full`), starting with the smallest `allocatedCapital` that's
      still meaningful to observe.
  - **Soak test — honestly out of scope for this session.** "Let the full stack run continuously
    for an extended period (a day or more) and watch for crashes, memory leaks, missed
    reconciliation mismatches, and WS-reconnect behavior under real conditions" is inherently an
    elapsed-time activity. This phase built the monitoring/alerting that makes such a test
    *observable* (scheduled reconciliation, proactive kill-switch/mismatch alerts) — actually
    running it is a follow-up the operator needs to let happen over real time, not something
    completed here. Don't mark this sub-item done without actually having let it run.

## Repository layout

npm workspaces at the repo root:

- `apps/ui` — the Next.js dashboard (App Router, React 19, TypeScript strict, Tailwind v4
  CSS-first). Live: strategy list (`app/page.tsx`), strategy detail with stats/trade log/controls
  (`app/strategies/[slug]/`), SSE bridge (`app/api/stream`), control-API proxy
  (`app/api/strategies/[slug]/[action]`), Mongo/Redis/stats helpers in `lib/`.
- `apps/engine` — the trading engine. Long-running (Phase 4) — see its own section above for the
  full breakdown (`broker/`, `strategy/`, `marketData/`, `risk/`, `events/`, `reconciliation/`,
  `registry.ts`, `controlApi.ts`, `strategyRunner.ts`, `index.ts`).
- `apps/chatops` — Telegram bot (`bot.ts` commands, `index.ts` bootstrap/auth-gate; see Phase 5).
- `packages/shared` — cross-app types, the Mongo data layer, money helpers, `computeStrategyStats`,
  and `ControlApiClient` (see Phase 1/2/5).
- `docker-compose.yml` — local Mongo + Redis for dev.

**Module resolution note** (see Phase 4's first bug): every package uses `module: "ESNext"` /
`moduleResolution: "bundler"` with **extensionless relative imports** — not the NodeNext `.js`
convention. This is deliberate and load-bearing: it's the one convention `tsc`, `tsx`, and
Next.js's Turbopack all agree on. Don't "fix" imports by adding `.js` extensions.

## Commands

```bash
npm install                                    # installs all workspaces from the repo root

npm run dev --workspace=@trade-bot/ui          # Next.js dev server (http://localhost:3000)
npm run build --workspace=@trade-bot/ui
npm run lint --workspace=@trade-bot/ui

npm run dev --workspace=@trade-bot/engine       # tsx watch — long-running, seeds/streams demo strategies
npm run start --workspace=@trade-bot/engine     # same, via tsx (not node dist/, see module resolution note)
npm run typecheck --workspace=@trade-bot/engine
npm run testnet-smoke --workspace=@trade-bot/engine           # needs BINANCE_API_KEY/SECRET (spot testnet)
npm run futures-testnet-smoke --workspace=@trade-bot/engine   # needs BINANCE_FUTURES_API_KEY/SECRET (futures testnet)

npm run dev --workspace=@trade-bot/chatops      # tsx watch — needs TELEGRAM_BOT_TOKEN/ALLOWED_CHAT_IDS
npm run typecheck --workspace=@trade-bot/chatops

docker compose up -d                            # local Mongo (27017) + Redis (6379)
```

Engine env vars beyond `MONGODB_URI`/`REDIS_URL`: `ENGINE_CONTROL_API_PORT` (default 4001),
`ENGINE_CONTROL_API_TOKEN` (default is a dev-only placeholder — set a real one outside local dev).
The UI reads the same two (`ENGINE_CONTROL_API_URL`, `ENGINE_CONTROL_API_TOKEN`) to reach the
engine's control API server-side.

No test runner is configured yet.

## Agent rules file

`apps/ui/AGENTS.md` (and `apps/ui/CLAUDE.md`, which just imports it via `@AGENTS.md`) is
auto-generated and rewritten by `next dev` itself (see
`node_modules/next/dist/server/lib/generate-agent-files.js`, resolved from `apps/ui`). Do not
hand-edit its content — if it reappears in a diff after being removed, that's expected;
committing it is fine. It currently warns that this Next.js version may have breaking changes
from training data and to check `apps/ui/node_modules/next/dist/docs/` before writing framework
code.
