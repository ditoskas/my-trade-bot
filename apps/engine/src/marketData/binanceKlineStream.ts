import { toDecimal128 } from "@trade-bot/shared";
import type { Candle } from "../broker/types";

export interface KlineStreamOptions {
  symbol: string;
  interval: string;
  onClosedCandle: (candle: Candle) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface BinanceKlineMessage {
  k: {
    t: number;
    T: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean;
  };
}

// Long-lived connection to Binance's public (unauthenticated) kline
// WebSocket stream — real-time market data, no API key, distinct from
// BinanceBroker/BinanceFuturesBroker (order execution). Uses Node's
// built-in global WebSocket (Node 22+), no extra dependency. Reconnects
// with exponential backoff (capped at 30s) on close/error.
//
// Known gap: candles missed while disconnected aren't backfilled — the
// strategy just resumes from whatever candle arrives next. Acceptable for
// Phase 4's live-dashboard demo; a gapless feed would need to detect the
// gap and backfill via fetchHistoricalCandles on reconnect, not built here.
export class BinanceKlineStream {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelayMs = 1000;

  constructor(private readonly options: KlineStreamOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  private connect(): void {
    const url = `wss://stream.binance.com:9443/ws/${this.options.symbol.toLowerCase()}@kline_${this.options.interval}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelayMs = 1000;
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as BinanceKlineMessage;
        if (!data.k.x) {
          return; // only act on closed candles, not the in-progress one
        }
        const candle: Candle = {
          symbol: this.options.symbol,
          openTime: new Date(data.k.t),
          closeTime: new Date(data.k.T),
          open: toDecimal128(data.k.o),
          high: toDecimal128(data.k.h),
          low: toDecimal128(data.k.l),
          close: toDecimal128(data.k.c),
          volume: toDecimal128(data.k.v),
        };
        void this.options.onClosedCandle(candle);
      } catch (error) {
        this.options.onError?.(error as Error);
      }
    });

    ws.addEventListener("close", () => {
      if (this.closed) {
        return;
      }
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      setTimeout(() => this.connect(), delay);
    });

    ws.addEventListener("error", () => {
      // "close" always follows "error" for a failed connection — reconnect
      // logic lives entirely in the close handler to avoid double-firing.
    });
  }
}
