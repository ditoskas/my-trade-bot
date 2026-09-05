import { toDecimal128 } from "@trade-bot/shared";
import type { Candle } from "../broker/types";

export interface FuturesKlineStreamOptions {
  symbol: string;
  interval: string;
  onClosedCandle: (candle: Candle) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface BinanceFuturesKlineMessage {
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

// Same shape and reconnect behavior as marketData/binanceKlineStream.ts,
// pointed at Binance's USDT-M futures market WebSocket (fstream) instead
// of spot (stream.binance.com) — see binanceFuturesPublic.ts for why a
// futures-calibrated strategy shouldn't use spot market data. Kept as a
// separate class rather than parametrizing the spot one, matching the
// additive-not-modifying convention already used for BinanceFuturesBroker.
export class BinanceFuturesKlineStream {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelayMs = 1000;

  constructor(private readonly options: FuturesKlineStreamOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  private connect(): void {
    const url = `wss://fstream.binance.com/ws/${this.options.symbol.toLowerCase()}@kline_${this.options.interval}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelayMs = 1000;
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as BinanceFuturesKlineMessage;
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
