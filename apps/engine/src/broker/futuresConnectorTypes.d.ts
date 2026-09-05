// @binance/futures-connector ships no TypeScript types at all (v0.1.7 — see
// CLAUDE.md Phase 3b for why it's treated as less mature than @binance/spot).
// This declares only the methods BinanceFuturesBroker actually calls, typed
// loosely (raw axios-style response, data left as unknown) since there's no
// vendor contract to be more precise against — every field read off `data`
// in binanceFuturesBroker.ts is validated at runtime, not trusted from here.
declare module "@binance/futures-connector" {
  interface UMFuturesOptions {
    baseURL?: string;
    timeout?: number;
  }

  interface UMFuturesResponse {
    data: unknown;
    status: number;
  }

  export class UMFutures {
    constructor(apiKey: string, apiSecret: string, options?: UMFuturesOptions);
    newOrder(
      symbol: string,
      side: string,
      type: string,
      options?: Record<string, unknown>,
    ): Promise<UMFuturesResponse>;
    changeInitialLeverage(
      symbol: string,
      leverage: number,
      options?: Record<string, unknown>,
    ): Promise<UMFuturesResponse>;
    changeMarginType(symbol: string, marginType: string, options?: Record<string, unknown>): Promise<UMFuturesResponse>;
    changePositionMode(dualSidePosition: string, options?: Record<string, unknown>): Promise<UMFuturesResponse>;
    getPositionMode(options?: Record<string, unknown>): Promise<UMFuturesResponse>;
    getExchangeInfo(): Promise<UMFuturesResponse>;
    getAccountInformationV3(options?: Record<string, unknown>): Promise<UMFuturesResponse>;
    getCurrentAllOpenOrders(options?: Record<string, unknown>): Promise<UMFuturesResponse>;
    getPositionInformationV3(options?: Record<string, unknown>): Promise<UMFuturesResponse>;
    getAccountTradeList(symbol: string, options?: Record<string, unknown>): Promise<UMFuturesResponse>;
  }
}
