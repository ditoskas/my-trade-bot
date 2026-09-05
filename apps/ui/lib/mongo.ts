import { connectMongo, type MongoConnection } from "@trade-bot/shared";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/trade-bot-dev";

// Next.js dev mode reloads route modules on every request in some cases —
// caching the connection promise on globalThis avoids opening a new Mongo
// connection per request/hot-reload. Standard pattern for this framework.
declare global {
  var __mongoConnectionPromise: Promise<MongoConnection> | undefined;
}

export function getMongo(): Promise<MongoConnection> {
  if (!globalThis.__mongoConnectionPromise) {
    globalThis.__mongoConnectionPromise = connectMongo(MONGODB_URI);
  }
  return globalThis.__mongoConnectionPromise;
}
