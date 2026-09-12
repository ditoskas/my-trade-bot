// Manual verification that BinanceFuturesBroker actually works against a
// real exchange — Binance's USDT-M futures testnet, fake funds, zero
// financial risk. Run with:
//   npm run futures-testnet-smoke --workspace=@trade-bot/engine
// after setting BINANCE_FUTURES_API_KEY / BINANCE_FUTURES_API_SECRET (from
// https://testnet.binancefuture.com — NOT the same keys or site as the
// spot testnet) in .env or the shell. Hardcoded useTestnet: true below —
// never point this script at mainnet.
import { toDecimal128 } from "@trade-bot/shared";
import { BinanceFuturesBroker } from "../broker/binanceFuturesBroker";

const apiKey = process.env.BINANCE_FUTURES_API_KEY;
const apiSecret = process.env.BINANCE_FUTURES_API_SECRET;
const symbol = process.env.BINANCE_FUTURES_SMOKE_SYMBOL ?? "BTCUSDT";
const quantity = process.env.BINANCE_FUTURES_SMOKE_QUANTITY ?? "0.002";
const leverage = Number(process.env.BINANCE_FUTURES_SMOKE_LEVERAGE ?? "3");

if (!apiKey || !apiSecret) {
  console.error(
    "Set BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_API_SECRET (from https://testnet.binancefuture.com, " +
      "a separate site/account from the spot testnet) before running this script.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const broker = new BinanceFuturesBroker({ apiKey: apiKey!, apiSecret: apiSecret!, useTestnet: true });

  const isHedgeMode = await broker.detectPositionMode();
  console.log(`[smoke] detected position mode: ${isHedgeMode ? "Hedge (dual-side)" : "One-way"} — leaving it as-is`);

  console.log(`[smoke] configuring ${symbol}: ISOLATED margin, ${leverage}x leverage...`);
  await broker.configureSymbol(symbol, leverage, "ISOLATED");

  console.log(`[smoke] opening a MARKET LONG for ${quantity} ${symbol} on Binance futures testnet...`);
  const openResult = await broker.placeOrder({
    clientOrderId: `fsmoke-open-${Date.now()}`,
    symbol,
    side: "BUY",
    type: "MARKET",
    quantity: toDecimal128(quantity),
    // Only actually sent by BinanceFuturesBroker when the account is in
    // Hedge Mode — harmless to always pass, see placeOrder's comment.
    positionSide: "LONG",
  });
  logOrderResult("open", openResult);

  console.log(`[smoke] closing the position (SELL, reduceOnly under One-way / same positionSide under Hedge)...`);
  const closeResult = await broker.placeOrder({
    clientOrderId: `fsmoke-close-${Date.now()}`,
    symbol,
    side: "SELL",
    type: "MARKET",
    quantity: toDecimal128(quantity),
    reduceOnly: true,
    positionSide: "LONG",
  });
  logOrderResult("close", closeResult);
}

function logOrderResult(label: string, result: Awaited<ReturnType<BinanceFuturesBroker["placeOrder"]>>): void {
  console.log(`[smoke] ${label} order result:`, {
    exchangeOrderId: result.exchangeOrderId,
    status: result.status,
    executedQuantity: result.executedQuantity.toString(),
    cumulativeQuoteQuantity: result.cumulativeQuoteQuantity.toString(),
    fills: result.fills.map((fill) => ({
      price: fill.price.toString(),
      quantity: fill.quantity.toString(),
      commission: fill.commission.toString(),
      commissionAsset: fill.commissionAsset,
    })),
  });
}

main().catch((error: unknown) => {
  console.error("[smoke] fatal error:", error);
  process.exitCode = 1;
});
