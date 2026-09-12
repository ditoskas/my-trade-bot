import { ObjectId, type Db } from "mongodb";
import {
  auditLogCollection,
  closeMongo,
  connectMongo,
  ensureIndexes,
  strategiesCollection,
  toDecimal128,
  type Strategy,
} from "@trade-bot/shared";
import type { Broker } from "./broker/types";
import { BinanceFuturesBroker } from "./broker/binanceFuturesBroker";
import { PaperBroker } from "./broker/paperBroker";
import { startControlApi, type StrategyActionResult } from "./controlApi";
import { EventPublisher } from "./events/redisPublisher";
import { fetchHistoricalCandles } from "./marketData/binancePublic";
import { BinanceKlineStream } from "./marketData/binanceKlineStream";
import { fetchHistoricalFuturesCandles } from "./marketData/binanceFuturesPublic";
import { BinanceFuturesKlinePoller } from "./marketData/binanceFuturesKlinePoller";
import { reconcile } from "./reconciliation/reconcile";
import { StrategyRegistry, type RegisteredStrategy } from "./registry";
import { CapitalLedger } from "./risk/capitalLedger";
import { RiskManager } from "./risk/riskManager";
import { BTC_HIGH_RISK_AUX_TAG_4H, BtcHighRiskStrategy } from "./strategy/btcHighRisk";
import { MovingAverageCrossStrategy } from "./strategy/movingAverageCross";
import { warmUpAlgorithm, warmUpAuxCandles } from "./strategy/warmUp";
import { StrategyRunner } from "./strategyRunner";

// Phase 4: the engine is now a genuinely long-running process — candles
// arrive from a live Binance WebSocket stream (marketData/
// binanceKlineStream.ts), strategies keep running until the process is
// stopped, and an internal HTTP API (controlApi.ts) exposes pause/resume/
// kill for the Phase 4 dashboard (and, later, Phase 5 chatops) to call.
// Before this phase, index.ts was a one-shot script that replayed a fixed
// batch of historical candles and exited — see CLAUDE.md Phase 2/3b.

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/trade-bot-dev";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const CONTROL_API_PORT = Number(process.env.ENGINE_CONTROL_API_PORT ?? "4001");
// Dev-only default — real deployments must set a real secret. Never expose
// this port beyond 127.0.0.1 regardless of the token.
const CONTROL_API_TOKEN = process.env.ENGINE_CONTROL_API_TOKEN ?? "dev-only-insecure-token";
const STATUS_HEARTBEAT_MS = 30_000;
// Phase 6: reconcile() (Phase 3) existed but nothing ever called it
// automatically — it only ran from the manual testnet-smoke scripts. Only
// covers the spot account (see reconcile.ts); futures reconciliation isn't
// built. Defaults to testnet — BINANCE_USE_TESTNET must be explicitly set
// to "false" to ever point this at a real account, never the other way.
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 5 * 60_000);
const BINANCE_USE_TESTNET = process.env.BINANCE_USE_TESTNET !== "false";

// btc-high-risk-specific futures credentials. Same testnet-by-default
// pattern as BINANCE_USE_TESTNET above, plus one extra, strategy-specific
// gate: BTC_HIGH_RISK_ALLOW_LIVE must ALSO be explicitly "true" before this
// strategy will ever use a non-testnet broker. That second switch exists
// because the TypeScript port of this strategy is not yet verified against
// the original Pine backtest — a spot-check against real trades found it
// reproduced only 3 of 8 in the same window, direction-correct-but-1h-off
// on a 4th, and missed the rest entirely (see
// strategies/btc-high-risk.md's Engine port section). Until that's
// resolved, BINANCE_FUTURES_USE_TESTNET=false alone is not enough to risk
// real capital on this specific strategy, even though the same setting
// already gates spot reconciliation above without a second switch.
const BINANCE_FUTURES_API_KEY = process.env.BINANCE_FUTURES_API_KEY;
const BINANCE_FUTURES_API_SECRET = process.env.BINANCE_FUTURES_API_SECRET;
const BINANCE_FUTURES_USE_TESTNET = process.env.BINANCE_FUTURES_USE_TESTNET !== "false";
const BTC_HIGH_RISK_ALLOW_LIVE = process.env.BTC_HIGH_RISK_ALLOW_LIVE === "true";

interface DemoStrategyDef {
  slug: string;
  name: string;
  symbol: string;
  interval: string;
  fastPeriod: number;
  slowPeriod: number;
}

// Two strategies, two symbols — proves the dashboard actually renders a
// *list* with independently running/paused/killed state, not just one.
// A real strategy catalog would live in Mongo already; these are seeded
// here only because nothing yet creates strategies any other way (no admin
// UI, no Phase 5 chatops).
const DEMO_STRATEGIES: DemoStrategyDef[] = [
  { slug: "ma-cross-demo", name: "MA Cross Demo (BTCUSDT, paper)", symbol: "BTCUSDT", interval: "1m", fastPeriod: 5, slowPeriod: 20 },
  { slug: "ma-cross-demo-eth", name: "MA Cross Demo (ETHUSDT, paper)", symbol: "ETHUSDT", interval: "1m", fastPeriod: 5, slowPeriod: 20 },
];

async function getOrCreateStrategy(db: Db, def: DemoStrategyDef): Promise<Strategy> {
  const existing = await strategiesCollection(db).findOne({ slug: def.slug });
  if (existing) {
    return existing;
  }

  const doc: Strategy = {
    _id: new ObjectId(),
    slug: def.slug,
    name: def.name,
    description: `Phase 4 live-dashboard demo — ${def.fastPeriod}/${def.slowPeriod} period SMA cross on ${def.symbol}, long or short, 3x leverage.`,
    version: 1,
    lifecycleState: "paper",
    broker: "paper",
    symbols: [def.symbol],
    allocatedCapital: toDecimal128("1000"),
    allocatedCapitalAsset: "USDT",
    riskLimits: {
      maxPositionSize: toDecimal128("1000"),
      maxConcurrentPositions: 1,
      maxDrawdownPct: 20,
      maxLeverage: 3,
    },
    config: { fastPeriod: def.fastPeriod, slowPeriod: def.slowPeriod },
    // Off by default — see the `enabled` field's comment on the Strategy
    // model. A brand-new deployment starts every strategy disabled; only
    // enabling one via the dashboard (or a previous run having already
    // done so — this only applies to a doc's *first* creation) starts it.
    enabled: false,
    killSwitchEngaged: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await strategiesCollection(db).insertOne(doc);
  return doc;
}

// Builds and starts everything a demo strategy needs (algorithm, warm-up,
// broker, runner, market-data stream) and returns it ready to register —
// pulled out of the old inline boot loop so the exact same construction
// logic can also run later, on demand, when enableStrategy calls it for a
// strategy that wasn't running at boot.
async function startDemoStrategy(
  db: Db,
  def: DemoStrategyDef,
  doc: Strategy,
  publisher: EventPublisher,
): Promise<RegisteredStrategy> {
  const algorithm = new MovingAverageCrossStrategy(def.symbol, def.fastPeriod, def.slowPeriod);

  try {
    const history = await fetchHistoricalCandles(def.symbol, def.interval, def.slowPeriod);
    warmUpAlgorithm(algorithm, history);
    console.log(`[engine] warmed up "${doc.slug}" with ${history.length} historical candles`);
  } catch (error) {
    console.warn(`[engine] couldn't warm up "${doc.slug}" (${(error as Error).message}) — starting cold`);
  }

  const broker = new PaperBroker();
  const runner = new StrategyRunner(db, doc, algorithm, broker, new RiskManager(), new CapitalLedger(db), publisher);
  await runner.initialize();

  const stream = new BinanceKlineStream({
    symbol: def.symbol,
    interval: def.interval,
    onClosedCandle: async (candle) => {
      broker.setPrice(candle.symbol, candle.close);
      await runner.onCandle(candle);
    },
    onError: (error) => console.error(`[engine] ${def.symbol} stream error:`, error.message),
  });
  stream.start();

  console.log(`[engine] strategy "${doc.slug}" live on ${def.symbol} (${def.interval} candles)`);
  return { doc, runner, stream };
}

const BTC_HIGH_RISK_SLUG = "btc-high-risk";
const BTC_HIGH_RISK_SYMBOL = "BTCUSDT";
// Iteration 14's live-verified Pine backtest used 100x, hence the 100 here
// and the dedicated RiskManager(100) below — the default RiskManager()
// ceiling (20x) is deliberately left alone for every other strategy.
const BTC_HIGH_RISK_LEVERAGE = 100;

// Off by default, same as every other strategy (see getOrCreateStrategy's
// comment on `enabled`) — this is in addition to, not instead of, the
// existing BTC_HIGH_RISK_ALLOW_LIVE gate below: even once someone enables
// this from the dashboard, it still can't reach a real account without
// that second, strategy-specific switch also being set.
async function getOrCreateBtcHighRiskStrategy(db: Db): Promise<Strategy> {
  const existing = await strategiesCollection(db).findOne({ slug: BTC_HIGH_RISK_SLUG });
  if (existing) {
    return existing;
  }

  const doc: Strategy = {
    _id: new ObjectId(),
    slug: BTC_HIGH_RISK_SLUG,
    name: "BTC High-Risk (BTCUSDT.P, paper)",
    description:
      "Fibonacci pivot-retracement strategy, iteration 15 — see strategies/btc-high-risk.md for the full " +
      "backtest history. 100x leverage, night-session-only (20:00-06:00 UTC), 50.0%/78.6% Fib levels only " +
      "(38.2%/61.8% dropped), 4h candle wick-ratio entry filter (iteration 15) — see Entry logic items " +
      "11-13. Liquidation-tied (1/leverage) stop. NOTE: the engine port's signal-parity gap against " +
      "iteration 14 (see the Engine port section) is unresolved and predates this iteration's own filter.",
    version: 2,
    lifecycleState: "paper",
    broker: "paper",
    // CROSSED, not ISOLATED — see the CROSSED-margin note down in
    // startBtcHighRiskRuntime's configureSymbol call for why.
    marginMode: "CROSSED",
    symbols: [BTC_HIGH_RISK_SYMBOL],
    // 150, not the demo strategies' 1000 default — matches the real
    // account balance actually funded for this strategy (see
    // strategies/btc-high-risk.md's "Going live" note). This is a
    // completely internal bookkeeping baseline (CapitalLedger.getFreeCapital
    // falls back to it, see risk/capitalLedger.ts) — it is NOT read from
    // the real exchange balance, so it must be kept in sync by hand with
    // whatever's actually funded. If this doc already exists (the common
    // case — getOrCreateBtcHighRiskStrategy returns the existing doc
    // unchanged above), changing this default does nothing retroactively;
    // update the live Mongo document directly instead.
    allocatedCapital: toDecimal128("150"),
    allocatedCapitalAsset: "USDT",
    riskLimits: {
      maxPositionSize: toDecimal128("150"),
      maxConcurrentPositions: 1,
      // Iteration 14's Pine backtest drawdown was 27.92%; iteration 15
      // (this port) improved that to 16.57% in Pine, but that number is
      // unverified for the port itself given its unresolved parity gap —
      // left at 35 (comfortably above either number) rather than
      // tightening based on a Pine result this port isn't confirmed to
      // reproduce, so the breaker isn't tripped by ordinary variance on
      // the first rough patch.
      maxDrawdownPct: 35,
      maxLeverage: BTC_HIGH_RISK_LEVERAGE,
    },
    config: {},
    enabled: false,
    killSwitchEngaged: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await strategiesCollection(db).insertOne(doc);
  return doc;
}

// Same extraction rationale as startDemoStrategy above — this used to be
// inline in main()'s boot loop; now enableStrategy can call it too.
async function startBtcHighRiskRuntime(db: Db, doc: Strategy, publisher: EventPublisher): Promise<RegisteredStrategy> {
  const algorithm = new BtcHighRiskStrategy({ symbol: BTC_HIGH_RISK_SYMBOL, leverage: BTC_HIGH_RISK_LEVERAGE });

  // Futures data, not spot (see marketData/binanceFuturesPublic.ts) —
  // this strategy was calibrated against BTCUSDT.P, not spot BTCUSDT.
  try {
    const history1h = await fetchHistoricalFuturesCandles(BTC_HIGH_RISK_SYMBOL, "1h", 500);
    warmUpAlgorithm(algorithm, history1h);
    const history4h = await fetchHistoricalFuturesCandles(BTC_HIGH_RISK_SYMBOL, "4h", 200);
    warmUpAuxCandles(algorithm, BTC_HIGH_RISK_AUX_TAG_4H, history4h);
    console.log(
      `[engine] warmed up "${doc.slug}" with ${history1h.length} 1h + ${history4h.length} 4h historical futures candles`,
    );
  } catch (error) {
    console.warn(`[engine] couldn't warm up "${doc.slug}" (${(error as Error).message}) — starting cold`);
  }

  const usingFutures = Boolean(BINANCE_FUTURES_API_KEY && BINANCE_FUTURES_API_SECRET);
  const wouldBeLive = usingFutures && !BINANCE_FUTURES_USE_TESTNET;
  if (wouldBeLive && !BTC_HIGH_RISK_ALLOW_LIVE) {
    console.warn(
      `[engine] BINANCE_FUTURES_USE_TESTNET=false but BTC_HIGH_RISK_ALLOW_LIVE isn't "true" — forcing ` +
        `"${doc.slug}" onto testnet regardless. This strategy's TypeScript port isn't yet verified against ` +
        `its Pine backtest (see strategies/btc-high-risk.md's Engine port section) and won't touch a real ` +
        `account until that's resolved and this override is set deliberately.`,
    );
  }
  const effectiveUseTestnet = wouldBeLive && !BTC_HIGH_RISK_ALLOW_LIVE ? true : BINANCE_FUTURES_USE_TESTNET;
  const isLive = usingFutures && !effectiveUseTestnet;

  const broker: Broker = usingFutures
    ? new BinanceFuturesBroker({
        apiKey: BINANCE_FUTURES_API_KEY as string,
        apiSecret: BINANCE_FUTURES_API_SECRET as string,
        useTestnet: effectiveUseTestnet,
      })
    : new PaperBroker();

  if (broker instanceof BinanceFuturesBroker) {
    // Detect only — never force a position-mode change. See
    // BinanceFuturesBroker.detectPositionMode's comment for the 2026-09-12
    // incident this replaced (forcing One-way took the engine down for
    // ~34h whenever the operator had a manual Hedge-Mode position open).
    const isHedgeMode = await broker.detectPositionMode();
    console.log(
      `[engine] "${doc.slug}" detected Binance position mode: ${isHedgeMode ? "Hedge (dual-side)" : "One-way"} — leaving it as-is`,
    );
    // CROSSED, not ISOLATED (which is what this strategy was actually
    // designed and backtested around — see strategies/btc-high-risk.md's
    // "Going live" note). Switched because the real account this was
    // first deployed against has Multi-Assets Mode enabled, which Binance
    // does not allow combining with Isolated margin (-4175 "Cannot change
    // to ISOLATED mode due to credit status" — an active Multi-Assets
    // auto-borrow, not a bug here), and the user chose to switch margin
    // mode rather than resolve that on Binance's side. Real consequence,
    // not just a config toggle: this strategy's stop-loss
    // (BtcHighRiskStrategy's liqLossFrac, `1/leverage`) is a **self-imposed
    // software exit**, not something Binance enforces — under Isolated
    // margin a bug or missed exit is capped to that position's own
    // reserved margin; under Crossed, Binance can draw on the ENTIRE
    // futures wallet balance to cover a losing position before its own
    // liquidation engine steps in, so the real worst case is larger than
    // the strategy's own risk math assumes. Accepted deliberately, on a
    // small ($150) account.
    await broker.configureSymbol(BTC_HIGH_RISK_SYMBOL, BTC_HIGH_RISK_LEVERAGE, "CROSSED");
    console.log(
      `[engine] "${doc.slug}" configured on Binance futures ${effectiveUseTestnet ? "TESTNET" : "REAL ACCOUNT"} ` +
        `(${isHedgeMode ? "hedge" : "one-way"} mode, CROSSED, ${BTC_HIGH_RISK_LEVERAGE}x)`,
    );
  }

  // Sync broker/lifecycle to Mongo every startup, not just at doc
  // creation — credentials (and therefore which broker actually runs)
  // can change between restarts without the Mongo doc being recreated.
  doc.broker = usingFutures ? "binance-futures" : "paper";
  doc.lifecycleState = isLive ? "live_small" : "paper";
  doc.updatedAt = new Date();
  await strategiesCollection(db).updateOne(
    { _id: doc._id },
    { $set: { broker: doc.broker, lifecycleState: doc.lifecycleState, updatedAt: doc.updatedAt } },
  );

  // Dedicated RiskManager instance with a 100x ceiling — every other
  // strategy still gets the default RiskManager()'s 20x ceiling.
  // logHoldDecisions: true — this strategy is selective (real signals are
  // rare) and runs on 1h candles, so a HOLD row roughly hourly is cheap and
  // is the liveness signal the Decision tab/audit_log otherwise can't show
  // (see StrategyRunner's constructor comment). Not set for the demo
  // strategies (startDemoStrategy, default false) — they tick every 1
  // minute, where the same logging would add ~1,440 rows/day each.
  const runner = new StrategyRunner(
    db,
    doc,
    algorithm,
    broker,
    new RiskManager(BTC_HIGH_RISK_LEVERAGE),
    new CapitalLedger(db),
    publisher,
    true,
  );
  await runner.initialize();

  // REST polling, not the WebSocket stream — found live 2026-09-08 that
  // wss://fstream.binance.com opens but never delivers a message from
  // this deployment's host (Contabo, AS51167), while spot WS and futures
  // REST both work fine from the same host. See
  // marketData/binanceFuturesKlinePoller.ts's comment for the full story.
  const stream = new BinanceFuturesKlinePoller({
    symbol: BTC_HIGH_RISK_SYMBOL,
    interval: "1h",
    onClosedCandle: async (candle) => {
      if (broker instanceof PaperBroker) {
        broker.setPrice(candle.symbol, candle.close);
      }
      await runner.onCandle(candle);
    },
    onError: (error) => console.error(`[engine] ${BTC_HIGH_RISK_SYMBOL} 1h futures poll error:`, error.message),
  });
  stream.start();

  const auxStream4h = new BinanceFuturesKlinePoller({
    symbol: BTC_HIGH_RISK_SYMBOL,
    interval: "4h",
    onClosedCandle: (candle) => {
      algorithm.onAuxCandle(BTC_HIGH_RISK_AUX_TAG_4H, candle);
    },
    onError: (error) => console.error(`[engine] ${BTC_HIGH_RISK_SYMBOL} 4h futures poll error:`, error.message),
  });
  auxStream4h.start();

  console.log(`[engine] strategy "${doc.slug}" live on ${BTC_HIGH_RISK_SYMBOL} futures (1h candles + 4h confirmation, REST-polled)`);
  return { doc, runner, stream, auxStreams: [auxStream4h] };
}

interface StrategyCatalogEntry {
  slug: string;
  getOrCreateDoc: (db: Db) => Promise<Strategy>;
  start: (db: Db, doc: Strategy, publisher: EventPublisher) => Promise<RegisteredStrategy>;
}

async function main(): Promise<void> {
  const connection = await connectMongo(MONGODB_URI);
  const { db } = connection;
  await ensureIndexes(db);

  const publisher = await EventPublisher.connect(REDIS_URL);
  const registry = new StrategyRegistry(db);

  // Every strategy the engine knows how to run, whether or not it's
  // currently enabled. Adding a new strategy means adding an entry here
  // and deploying — see CLAUDE.md's "Adding a new strategy" section for
  // the full process. It shows up disabled (enabled: false, per
  // getOrCreateStrategy/getOrCreateBtcHighRiskStrategy's default) until
  // someone explicitly turns it on from the dashboard; nothing here
  // starts a strategy's runner or opens a market-data connection just
  // because it's in this list.
  const catalog: StrategyCatalogEntry[] = [
    ...DEMO_STRATEGIES.map(
      (def): StrategyCatalogEntry => ({
        slug: def.slug,
        getOrCreateDoc: (db) => getOrCreateStrategy(db, def),
        start: (db, doc, publisher) => startDemoStrategy(db, def, doc, publisher),
      }),
    ),
    {
      slug: BTC_HIGH_RISK_SLUG,
      getOrCreateDoc: getOrCreateBtcHighRiskStrategy,
      start: startBtcHighRiskRuntime,
    },
  ];

  // Wraps a catalog entry's start() so one strategy's fatal startup error
  // can't silently leave the process half-broken. Before this (2026-09-12
  // incident, see CLAUDE.md Phase 3b), an uncaught throw from
  // startBtcHighRiskRuntime propagated straight out of this loop, past
  // main()'s own try/catch (which only logs and sets process.exitCode,
  // never calls process.exit) — since strategies earlier in the catalog had
  // already opened live connections keeping the event loop alive, the
  // process kept running under systemd looking perfectly healthy while
  // btc-high-risk had simply never started, for ~34 hours, with nothing
  // paging anyone. Now: the failure is caught, logged loudly, written to
  // audit_log as STRATEGY_START_FAILED (which chatops's alert watcher pages
  // on, same as KILL_SWITCH/RECONCILIATION_MISMATCH), and every other
  // catalog entry still gets its turn.
  async function startCatalogEntryOrAlert(
    entry: StrategyCatalogEntry,
    doc: Strategy,
  ): Promise<RegisteredStrategy | null> {
    try {
      return await entry.start(db, doc, publisher);
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[engine] FATAL: strategy "${doc.slug}" failed to start — not registered:`, error);
      try {
        await auditLogCollection(db).insertOne({
          _id: new ObjectId(),
          strategyId: doc._id,
          eventType: "STRATEGY_START_FAILED",
          source: "engine",
          payload: { error: message },
          timestamp: new Date(),
        });
      } catch (auditError) {
        console.error(
          `[engine] also failed to write STRATEGY_START_FAILED for "${doc.slug}":`,
          (auditError as Error).message,
        );
      }
      await publisher.publish({
        type: "STRATEGY_START_FAILED",
        strategyId: doc._id.toHexString(),
        strategySlug: doc.slug,
        payload: { error: message },
      });
      return null;
    }
  }

  for (const entry of catalog) {
    const doc = await entry.getOrCreateDoc(db);
    if (doc.enabled) {
      const registered = await startCatalogEntryOrAlert(entry, doc);
      if (registered) {
        registry.register(registered);
      }
    } else {
      console.log(
        `[engine] strategy "${doc.slug}" exists but is disabled — not starting (enable it from the dashboard)`,
      );
    }
  }

  // Starts a catalog strategy that isn't currently running. A no-op
  // (reports success) if it's already running — enabling an already-
  // enabled strategy isn't an error. See StrategyRunner.initialize for how
  // this stays safe even if the strategy has a real position open from
  // before the engine last restarted.
  // Shared by enableStrategy/disableStrategy — same "write the durable
  // record, then best-effort tell the live dashboard" shape
  // StrategyRunner.audit uses for every other engine event.
  async function auditAndPublish(
    strategyId: Strategy["_id"],
    slug: string,
    eventType: "ENABLED" | "DISABLED",
  ): Promise<void> {
    try {
      await auditLogCollection(db).insertOne({
        _id: new ObjectId(),
        strategyId,
        eventType,
        source: "engine",
        payload: {},
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`[engine] audit log write failed for ${eventType} on "${slug}":`, (error as Error).message);
    }
    await publisher.publish({
      type: eventType,
      strategyId: strategyId.toHexString(),
      strategySlug: slug,
      payload: { enabled: eventType === "ENABLED" },
    });
  }

  async function enableStrategy(slug: string): Promise<StrategyActionResult> {
    if (registry.get(slug)) {
      return { ok: true };
    }
    const entry = catalog.find((candidate) => candidate.slug === slug);
    if (!entry) {
      return { ok: false, error: `unknown strategy "${slug}"` };
    }
    const doc = await entry.getOrCreateDoc(db);
    const registered = await startCatalogEntryOrAlert(entry, doc);
    if (!registered) {
      return { ok: false, error: `"${slug}" failed to start — see logs / audit_log's STRATEGY_START_FAILED entry` };
    }
    registered.doc.enabled = true;
    registered.doc.updatedAt = new Date();
    await strategiesCollection(db).updateOne(
      { _id: registered.doc._id },
      { $set: { enabled: true, updatedAt: registered.doc.updatedAt } },
    );
    registry.register(registered);
    await auditAndPublish(registered.doc._id, slug, "ENABLED");
    console.log(`[engine] strategy "${slug}" enabled via the dashboard`);
    return { ok: true };
  }

  // Stops a running catalog strategy's runner and market-data connections
  // and marks it disabled in Mongo. Refuses while a real position is open
  // — see StrategyRunner.hasOpenPosition's comment on why: stopping the
  // runner would abandon that position's exit management entirely, with
  // nothing left watching it for a stop or a reversal signal.
  async function disableStrategy(slug: string): Promise<StrategyActionResult> {
    const entry = registry.get(slug);
    if (!entry) {
      // Not currently running (already disabled, or an unknown slug) —
      // sync the flag in Mongo anyway in case it's out of sync, but only
      // if the strategy actually exists.
      const result = await strategiesCollection(db).updateOne(
        { slug },
        { $set: { enabled: false, updatedAt: new Date() } },
      );
      return result.matchedCount > 0 ? { ok: true } : { ok: false, error: `unknown strategy "${slug}"` };
    }
    if (entry.runner.hasOpenPosition()) {
      return { ok: false, error: `"${slug}" has an open position — wait for it to close before disabling` };
    }
    registry.unregister(slug);
    entry.doc.enabled = false;
    entry.doc.updatedAt = new Date();
    await strategiesCollection(db).updateOne(
      { _id: entry.doc._id },
      { $set: { enabled: false, updatedAt: entry.doc.updatedAt } },
    );
    await auditAndPublish(entry.doc._id, slug, "DISABLED");
    console.log(`[engine] strategy "${slug}" disabled via the dashboard`);
    return { ok: true };
  }

  const controlApiServer = startControlApi({
    port: CONTROL_API_PORT,
    authToken: CONTROL_API_TOKEN,
    registry,
    enableStrategy,
    disableStrategy,
  });

  const heartbeat = setInterval(() => {
    for (const entry of registry.list()) {
      void publisher.publish({
        type: "STATUS",
        strategyId: entry.doc._id.toHexString(),
        strategySlug: entry.doc.slug,
        payload: {
          lifecycleState: entry.doc.lifecycleState,
          killSwitchEngaged: entry.doc.killSwitchEngaged,
        },
      });
    }
  }, STATUS_HEARTBEAT_MS);

  const binanceApiKey = process.env.BINANCE_API_KEY;
  const binanceApiSecret = process.env.BINANCE_API_SECRET;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  if (binanceApiKey && binanceApiSecret) {
    reconcileTimer = setInterval(() => {
      void reconcile(db, { apiKey: binanceApiKey, apiSecret: binanceApiSecret, useTestnet: BINANCE_USE_TESTNET })
        .then((mismatches) => {
          if (mismatches.length > 0) {
            console.warn(`[engine] reconciliation found ${mismatches.length} mismatch(es):`, mismatches);
          }
        })
        .catch((error: unknown) => console.error("[engine] reconciliation failed:", (error as Error).message));
    }, RECONCILE_INTERVAL_MS);
    console.log(
      `[engine] spot reconciliation scheduled every ${RECONCILE_INTERVAL_MS / 60_000} min ` +
        `(testnet: ${BINANCE_USE_TESTNET})`,
    );
  } else {
    console.log("[engine] BINANCE_API_KEY/SECRET not set — spot reconciliation disabled (no real account to check)");
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("[engine] shutting down...");
    clearInterval(heartbeat);
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
    }
    registry.stopAll();
    controlApiServer.close();
    await publisher.close();
    await closeMongo(connection);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log("[engine] running — press Ctrl+C to stop");
}

// Last-resort safety net, not a substitute for the fixes at each real call
// site (StrategyRunner.onCandle, the kline stream classes) — Node
// terminates the whole process on an unhandled rejection by default, which
// is exactly what took down an entire overnight run (both demo strategies
// included) over one transient Mongo hiccup during an audit-log write.
// Every strategy shares this one process, so any rejection that still
// slips through is logged and the process keeps running rather than
// silently going down for every strategy at once.
process.on("unhandledRejection", (reason) => {
  console.error("[engine] unhandled rejection (continuing):", reason);
});

main().catch((error: unknown) => {
  console.error("[engine] fatal error:", error);
  process.exitCode = 1;
});
