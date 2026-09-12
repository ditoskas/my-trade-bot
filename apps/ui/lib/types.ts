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
  // Whether the engine currently runs this strategy's runner/market-data
  // connections at all — distinct from lifecycleState/killSwitchEngaged
  // (see the Strategy model's `enabled` field comment).
  enabled: boolean;
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

// One apps/engine audit_log entry (see packages/shared/src/models/auditLog.ts)
// scoped to this strategy — every DECISION/ORDER_INTENT/ORDER_FILLED/
// RISK_BLOCK/KILL_SWITCH/etc. event, not just closed trades, so a signal
// that never resulted in a filled order is still visible here.
export interface DecisionLogEntrySummary {
  id: string;
  eventType: string;
  source: string;
  payload: Record<string, unknown>;
  timestamp: string;
}
