import { ObjectId, type Db } from "mongodb";
import { closeMongo, connectMongo, ensureIndexes, strategiesCollection, toDecimal128, type Strategy } from "@trade-bot/shared";
import { PaperBroker } from "./broker/paperBroker";
import { startControlApi } from "./controlApi";
import { EventPublisher } from "./events/redisPublisher";
import { fetchHistoricalCandles } from "./marketData/binancePublic";
import { BinanceKlineStream } from "./marketData/binanceKlineStream";
import { StrategyRegistry } from "./registry";
import { CapitalLedger } from "./risk/capitalLedger";
import { RiskManager } from "./risk/riskManager";
import { MovingAverageCrossStrategy } from "./strategy/movingAverageCross";
import { warmUpAlgorithm } from "./strategy/warmUp";
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

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("[engine] shutting down...");
    clearInterval(heartbeat);
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

main().catch((error: unknown) => {
  console.error("[engine] fatal error:", error);
  process.exitCode = 1;
});
