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

- [ ] **Phase 3b — Futures pivot.** Not started. Binance USDT-M perpetual futures, isolated
  margin per strategy, one-way position mode (account-level setting), per-strategy configurable
  leverage with a hard system ceiling enforced by the Risk Manager. Uses the official
  `@binance/futures-connector` (`github.com/binance/binance-futures-connector-node`) — early
  (v0.1.7) compared to `@binance/spot` (v32), worth treating as less battle-tested. Existing spot
  code (`BinanceBroker`, spot `reconcile()`) is kept as-is, not deleted — futures is additive:
  - Schema: `StrategySignal` gains `ENTER_SHORT`/`EXIT_SHORT` (spot couldn't short; futures can).
    `RiskLimits.maxLeverage` (per-strategy, enforced against a hard ceiling). `Strategy.marginMode`
    (`"ISOLATED" | "CROSSED"`). `Order` gains optional `reduceOnly`/`positionSide`. `Trade` gains
    `leverage` and `fundingFeesPaid` (funding-fee computation itself is deferred — a real gap to
    flag, not solved yet).
  - Position sizing changes: margin reserved (capital ledger) is the strategy's free capital;
    notional exposure = margin × leverage. `StrategyRunner`'s entry/exit logic generalizes from
    long-only to long-or-short.
  - `BinanceFuturesBroker` needs one-time account setup (position mode, per-symbol margin type and
    leverage) done at strategy start, not per-order.
  - Known gap to flag rather than hide: liquidation-price monitoring (auto-flatten before
    liquidation) is deferred to Phase 6 hardening — the Risk Manager will enforce a leverage
    ceiling and the kill switch/lifecycle checks, but not track live margin ratio yet. Futures
    reconciliation (positions/margin balance, not spot balances) also isn't built yet.
- [ ] **Phase 4 — Live dashboard.** Redis pub/sub → WS/SSE bridge → Next.js pages: strategy
  list/state, per-strategy stats (Sharpe, max drawdown, win rate, profit factor), trade log, kill
  switch.
- [ ] **Phase 5 — Chatops.** Fixed Telegram commands first, calling Engine's internal API; MCP/NL
  layer added afterward with an allow-list and confirmation step.
- [ ] **Phase 6 — Hardening before real capital.** Security review of secrets/API key scoping,
  monitoring/alerting on crashes and reconciliation mismatches, then a real paper-trading soak
  test in the deployed environment before going live with small capital.

## Repository layout

npm workspaces at the repo root:

- `apps/ui` — the Next.js dashboard (App Router, React 19, TypeScript strict, Tailwind v4
  CSS-first). No trading-bot UI yet, just the `create-next-app` default page.
- `apps/engine` — trading engine (placeholder entrypoint only; see Phase 2/3).
- `apps/chatops` — Telegram bot service (placeholder entrypoint only; see Phase 5).
- `packages/shared` — cross-app types and the `Broker` interface (empty placeholder; see Phase 2).
- `docker-compose.yml` — local Mongo + Redis for dev.

## Commands

```bash
npm install                                    # installs all workspaces from the repo root

npm run dev --workspace=@trade-bot/ui          # Next.js dev server (http://localhost:3000)
npm run build --workspace=@trade-bot/ui
npm run lint --workspace=@trade-bot/ui

npm run dev --workspace=@trade-bot/engine       # tsx watch
npm run typecheck --workspace=@trade-bot/engine

npm run dev --workspace=@trade-bot/chatops      # tsx watch
npm run typecheck --workspace=@trade-bot/chatops

docker compose up -d                            # local Mongo (27017) + Redis (6379)
```

No test runner is configured yet.

## Agent rules file

`apps/ui/AGENTS.md` (and `apps/ui/CLAUDE.md`, which just imports it via `@AGENTS.md`) is
auto-generated and rewritten by `next dev` itself (see
`node_modules/next/dist/server/lib/generate-agent-files.js`, resolved from `apps/ui`). Do not
hand-edit its content — if it reappears in a diff after being removed, that's expected;
committing it is fine. It currently warns that this Next.js version may have breaking changes
from training data and to check `apps/ui/node_modules/next/dist/docs/` before writing framework
code.
