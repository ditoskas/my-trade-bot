// Manual verification that BinanceBroker and reconcile() actually work
// against a real exchange — Binance's spot testnet, fake funds, zero
// financial risk. Run with:
//   npm run testnet-smoke --workspace=@trade-bot/engine
// after setting BINANCE_API_KEY / BINANCE_API_SECRET (from
// https://testnet.binance.vision, not a real account) in .env or the shell.
// Hardcoded useTestnet: true below — never point this script at mainnet.
import { closeMongo, connectMongo, ensureIndexes, toDecimal128 } from "@trade-bot/shared";
import { BinanceBroker } from "../broker/binanceBroker";
import { reconcile } from "../reconciliation/reconcile";

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const symbol = process.env.BINANCE_SMOKE_SYMBOL ?? "BTCUSDT";
const quantity = process.env.BINANCE_SMOKE_QUANTITY ?? "0.001";

if (!apiKey || !apiSecret) {
  console.error(
    "Set BINANCE_API_KEY and BINANCE_API_SECRET (testnet keys from https://testnet.binance.vision) before running this script.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const broker = new BinanceBroker({ apiKey: apiKey!, apiSecret: apiSecret!, useTestnet: true });

  console.log(`[smoke] placing a MARKET BUY for ${quantity} ${symbol} on Binance testnet...`);
  const result = await broker.placeOrder({
    clientOrderId: `smoke-${Date.now()}`,
    symbol,
    side: "BUY",
    type: "MARKET",
    quantity: toDecimal128(quantity),
  });

  console.log("[smoke] order result:", {
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

  const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/trade-bot-dev";
  const connection = await connectMongo(uri);
  try {
    await ensureIndexes(connection.db);
    console.log("[smoke] running reconcile()...");
    const mismatches = await reconcile(connection.db, { apiKey: apiKey!, apiSecret: apiSecret!, useTestnet: true });
    console.log(`[smoke] reconcile found ${mismatches.length} mismatch(es):`, mismatches);
  } finally {
    await closeMongo(connection);
  }
}

main().catch((error: unknown) => {
  console.error("[smoke] fatal error:", error);
  process.exitCode = 1;
});
