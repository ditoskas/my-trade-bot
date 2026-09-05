import { createClient, type RedisClientType } from "redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
export const STRATEGY_EVENTS_CHANNEL = "strategy-events";

// Each SSE connection needs its own subscriber — Redis pub/sub
// subscriptions are per-connection, so this is deliberately not cached
// like getMongo() is.
export async function createSubscriber(): Promise<RedisClientType> {
  const client: RedisClientType = createClient({ url: REDIS_URL });
  client.on("error", (error: Error) => console.error("[redis] subscriber error:", error.message));
  await client.connect();
  return client;
}
