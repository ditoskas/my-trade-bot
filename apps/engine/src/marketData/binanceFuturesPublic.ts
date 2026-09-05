import { toDecimal128 } from "@trade-bot/shared";
import type { Candle } from "../broker/types";

// Same shape and same "no API key needed" rationale as
// marketData/binancePublic.ts, but Binance's USDT-M futures REST API
// instead of spot. Kept as a separate file rather than parametrizing the
// spot one — same additive-not-modifying convention CLAUDE.md's Phase 3b
// established for BinanceFuturesBroker alongside BinanceBroker. This
// matters for a strategy calibrated against perpetual futures price
// action (e.g. btc-high-risk, backtested on BTCUSDT.P): spot and
// perpetual prices track closely but aren't identical, and a strategy
// built around exact Fibonacci price levels shouldn't make live decisions
// off a different instrument than the one it trades and was calibrated
// against.
type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

export async function fetchHistoricalFuturesCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance futures klines request failed: ${response.status} ${response.statusText}`);
  }

  const rows = (await response.json()) as BinanceKlineRow[];
  return rows.map((row) => ({
    symbol,
    openTime: new Date(row[0]),
    closeTime: new Date(row[6]),
    open: toDecimal128(row[1]),
    high: toDecimal128(row[2]),
    low: toDecimal128(row[3]),
    close: toDecimal128(row[4]),
    volume: toDecimal128(row[5]),
  }));
}
