import { createClient, type RedisClientType } from "redis";
import type { AuditEventType } from "@trade-bot/shared";

export const STRATEGY_EVENTS_CHANNEL = "strategy-events";

export interface StrategyEvent {
  type: AuditEventType | "STATUS";
  strategyId: string;
  strategySlug: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Thin wrapper so StrategyRunner and the main loop don't touch Redis's API
// directly. If Redis is unreachable, connect() logs a warning and returns
// a publisher that silently no-ops — the live dashboard loses its feed,
// but a dashboard-only dependency being down must never take the trading
// engine down with it.
export class EventPublisher {
  private constructor(private readonly client: RedisClientType | null) {}

  static async connect(url: string): Promise<EventPublisher> {
    try {
      const client: RedisClientType = createClient({ url });
      client.on("error", (error: Error) => console.error("[redis] client error:", error.message));
      await client.connect();
      return new EventPublisher(client);
    } catch (error) {
      console.warn(
        `[redis] couldn't connect (${(error as Error).message}) — live dashboard updates disabled, engine continues`,
      );
      return new EventPublisher(null);
    }
  }

  async publish(event: Omit<StrategyEvent, "timestamp">): Promise<void> {
    if (!this.client) {
      return;
    }
    const fullEvent: StrategyEvent = { ...event, timestamp: new Date().toISOString() };
    try {
      await this.client.publish(STRATEGY_EVENTS_CHANNEL, JSON.stringify(fullEvent));
    } catch (error) {
      console.error("[redis] publish failed:", (error as Error).message);
    }
  }

  async close(): Promise<void> {
    await this.client?.quit();
  }
}
