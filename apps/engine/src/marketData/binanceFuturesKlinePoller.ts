import { fetchHistoricalFuturesCandles } from "./binanceFuturesPublic";
import type { Candle } from "../broker/types";

export interface FuturesKlinePollerOptions {
  symbol: string;
  interval: string;
  onClosedCandle: (candle: Candle) => void | Promise<void>;
  onError?: (error: Error) => void;
  // Exposed for tests; production always uses the default.
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 20_000;

// REST-polling replacement for BinanceFuturesKlineStream (the WebSocket
// version). Found live 2026-09-08: wss://fstream.binance.com opens and
// completes the WS handshake fine from this deployment's host but never
// delivers a single message — reproduced with plain Node WebSocket
// scripts, independent of this codebase entirely, while Binance's SPOT
// WebSocket and futures REST calls both work fine from the same host.
// Consistent with Binance applying stricter anti-bot/ToS filtering to
// futures market-data WebSocket specifically for some datacenter/VPS IP
// ranges (this deployment's host is on Contabo, AS51167) while leaving
// REST mostly unaffected. Since that's a Binance-side network policy, not
// a bug reachable from here, this polls the same public REST klines
// endpoint warmUp already uses instead of depending on the WS at all.
//
// 20s default poll interval is deliberately loose for 1h/4h candles —
// worst-case latency after a real close is one poll interval, totally
// fine for this strategy's timeframe, and keeps well under Binance's
// REST rate limits (this is a low-weight, unauthenticated endpoint).
export class BinanceFuturesKlinePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastClosedCandleCloseTime: number | null = null;
  private polling = false;

  constructor(private readonly options: FuturesKlinePollerOptions) {}

  start(): void {
    void this.poll(); // fire once immediately, don't wait a full interval on startup
    this.timer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    // Skip an overlapping run rather than queue - matches
    // StrategyRunner's own busy-guard reasoning: a slow/hanging REST call
    // should never cause two polls to race, and dropping one tick is
    // harmless at a 20s cadence.
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      // limit=2: the most recent candle is always still forming (its
      // close time is in the future), the one before it is the latest
      // actually-closed candle - same distinction the WS made via the
      // kline message's `x` (closed) flag.
      const recent = await fetchHistoricalFuturesCandles(this.options.symbol, this.options.interval, 2);
      const lastClosed = recent[recent.length - 2];
      if (!lastClosed) {
        return;
      }

      const closeTimeMs = lastClosed.closeTime.getTime();
      if (this.lastClosedCandleCloseTime === null) {
        // First poll: record the current most-recent close as the
        // baseline without firing - warmUp already processed this same
        // candle (and everything before it) from history, so firing here
        // would double-process it. Only genuinely new closes fire.
        this.lastClosedCandleCloseTime = closeTimeMs;
        return;
      }
      if (closeTimeMs <= this.lastClosedCandleCloseTime) {
        return; // no new close since last poll
      }

      this.lastClosedCandleCloseTime = closeTimeMs;
      await this.options.onClosedCandle(lastClosed);
    } catch (error) {
      this.options.onError?.(error as Error);
    } finally {
      this.polling = false;
    }
  }
}
