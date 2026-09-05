import { toDecimal128 } from "@trade-bot/shared";
import type { Candle } from "../broker/types";

// Deterministic-ish up-then-down price path, used only when the Binance
// public klines endpoint is unreachable — keeps the Phase 2 pipeline demo
// runnable without depending on outbound network access.
export function generateSyntheticCandles(symbol: string, count: number): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  let price = 100;

  for (let i = 0; i < count; i++) {
    const drift = i < count / 2 ? 1 : -1;
    price += drift * (0.5 + Math.random());
    const openTime = new Date(now - (count - i) * 60_000);
    const closeTime = new Date(openTime.getTime() + 60_000);

    candles.push({
      symbol,
      openTime,
      closeTime,
      open: toDecimal128(price.toFixed(2)),
      high: toDecimal128((price + 1).toFixed(2)),
      low: toDecimal128((price - 1).toFixed(2)),
      close: toDecimal128(price.toFixed(2)),
      volume: toDecimal128("1"),
    });
  }

  return candles;
}
