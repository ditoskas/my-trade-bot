import { toDecimal128 } from "@trade-bot/shared";
import type { Candle } from "../broker/types.js";

// Binance's public klines endpoint needs no API key — it's read-only market
// data, not trading capability, so fetching it here doesn't touch the
// "MCP/exchange credentials" concerns from CLAUDE.md. Row shape:
// [openTime, open, high, low, close, volume, closeTime, ...more we ignore].
type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

export async function fetchHistoricalCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance klines request failed: ${response.status} ${response.statusText}`);
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
