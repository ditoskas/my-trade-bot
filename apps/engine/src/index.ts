import { ObjectId, type Db } from "mongodb";
import { closeMongo, connectMongo, ensureIndexes, strategiesCollection, toDecimal128, type Strategy } from "@trade-bot/shared";
import type { Broker } from "./broker/types";
import { BinanceFuturesBroker } from "./broker/binanceFuturesBroker";
import { PaperBroker } from "./broker/paperBroker";
import { startControlApi } from "./controlApi";
import { EventPublisher } from "./events/redisPublisher";
import { fetchHistoricalCandles } from "./marketData/binancePublic";
import { BinanceKlineStream } from "./marketData/binanceKlineStream";
import { fetchHistoricalFuturesCandles } from "./marketData/binanceFuturesPublic";
import { BinanceFuturesKlineStream } from "./marketData/binanceFuturesKlineStream";
import { reconcile } from "./reconciliation/reconcile";
import { StrategyRegistry } from "./registry";
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
    killSwitchEngaged: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await strategiesCollection(db).insertOne(doc);
  return doc;
}

const BTC_HIGH_RISK_SLUG = "btc-high-risk";
const BTC_HIGH_RISK_SYMBOL = "BTCUSDT";
// Iteration 14's live-verified Pine backtest used 100x, hence the 100 here
// and the dedicated RiskManager(100) below — the default RiskManager()
// ceiling (20x) is deliberately left alone for every other strategy.
const BTC_HIGH_RISK_LEVERAGE = 100;

// Runs on PaperBroker for now (see strategies/btc-high-risk.md's Engine
// port section) — real futures market data, simulated fills, zero
// exchange calls. This is the "port to engine, verify it runs" step;
// swapping in BinanceFuturesBroker for futures-testnet, then a real
// account, are deliberate later steps per CLAUDE.md's lifecycle policy,
// not done here.
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
      "Fibonacci pivot-retracement strategy, iteration 14 — see strategies/btc-high-risk.md for the full " +
      "backtest history. 100x leverage, night-session-only (20:00-06:00 UTC), 50.0%/78.6% Fib levels only " +
      "(38.2%/61.8% dropped — see Entry logic items 11-12), liquidation-tied (1/leverage) stop.",
    version: 1,
    lifecycleState: "paper",
    broker: "paper",
    marginMode: "ISOLATED",
    symbols: [BTC_HIGH_RISK_SYMBOL],
    allocatedCapital: toDecimal128("1000"),
    allocatedCapitalAsset: "USDT",
    riskLimits: {
      maxPositionSize: toDecimal128("1000"),
      maxConcurrentPositions: 1,
      // Backtest's worst drawdown so far (iteration 14) was 27.92% — set a
      // bit above that rather than exactly at it, so the breaker isn't
      // tripped by ordinary variance on the very first rough patch.
      maxDrawdownPct: 35,
      maxLeverage: BTC_HIGH_RISK_LEVERAGE,
    },
    config: {},
    killSwitchEngaged: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await strategiesCollection(db).insertOne(doc);
  return doc;
}

async function main(): Promise<void> {
  const connection = await connectMongo(MONGODB_URI);
  const { db } = connection;
  await ensureIndexes(db);

  const publisher = await EventPublisher.connect(REDIS_URL);
  const registry = new StrategyRegistry(db);

  for (const def of DEMO_STRATEGIES) {
    const doc = await getOrCreateStrategy(db, def);
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

    registry.register({ doc, runner, stream });
    console.log(`[engine] strategy "${doc.slug}" live on ${def.symbol} (${def.interval} candles)`);
  }

  {
    const doc = await getOrCreateBtcHighRiskStrategy(db);
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
      await broker.configureOneWayPositionMode();
      await broker.configureSymbol(BTC_HIGH_RISK_SYMBOL, BTC_HIGH_RISK_LEVERAGE, "ISOLATED");
      console.log(
        `[engine] "${doc.slug}" configured on Binance futures ${effectiveUseTestnet ? "TESTNET" : "REAL ACCOUNT"} ` +
          `(one-way mode, ISOLATED, ${BTC_HIGH_RISK_LEVERAGE}x)`,
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
    const runner = new StrategyRunner(
      db,
      doc,
      algorithm,
      broker,
      new RiskManager(BTC_HIGH_RISK_LEVERAGE),
      new CapitalLedger(db),
      publisher,
    );

    const stream = new BinanceFuturesKlineStream({
      symbol: BTC_HIGH_RISK_SYMBOL,
      interval: "1h",
      onClosedCandle: async (candle) => {
        if (broker instanceof PaperBroker) {
          broker.setPrice(candle.symbol, candle.close);
        }
        await runner.onCandle(candle);
      },
      onError: (error) => console.error(`[engine] ${BTC_HIGH_RISK_SYMBOL} 1h futures stream error:`, error.message),
    });
    stream.start();

    const auxStream4h = new BinanceFuturesKlineStream({
      symbol: BTC_HIGH_RISK_SYMBOL,
      interval: "4h",
      onClosedCandle: (candle) => {
        algorithm.onAuxCandle(BTC_HIGH_RISK_AUX_TAG_4H, candle);
      },
      onError: (error) => console.error(`[engine] ${BTC_HIGH_RISK_SYMBOL} 4h futures stream error:`, error.message),
    });
    auxStream4h.start();

    registry.register({ doc, runner, stream, auxStreams: [auxStream4h] });
    console.log(`[engine] strategy "${doc.slug}" live on ${BTC_HIGH_RISK_SYMBOL} futures (1h candles + 4h confirmation)`);
  }

  const controlApiServer = startControlApi({ port: CONTROL_API_PORT, authToken: CONTROL_API_TOKEN, registry });

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
