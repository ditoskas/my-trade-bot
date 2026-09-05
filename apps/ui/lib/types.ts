// Plain, serializable shapes for passing Mongo documents across the
// Server -> Client Component boundary — Decimal128/ObjectId instances
// aren't serializable as React props, so every number-like field here is
// a string (kept as the exact decimal string, never parsed to a JS number
// until display) or a plain primitive.
export interface StrategySummary {
  slug: string;
  name: string;
  description?: string;
  symbols: string[];
  broker: string;
  lifecycleState: string;
  killSwitchEngaged: boolean;
  allocatedCapital: string;
  allocatedCapitalAsset: string;
  maxLeverage: number;
}

export interface TradeSummary {
  id: string;
  symbol: string;
  side: string;
  entryPrice: string;
  exitPrice: string;
  quantity: string;
  leverage: number;
  pnl: string;
  pnlPct: number;
  feesPaid: string;
  entryTime: string;
  exitTime: string;
  closeReason: string;
}
