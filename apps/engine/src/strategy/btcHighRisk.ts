import { Decimal } from "decimal.js";
import { toDecimalJs } from "@trade-bot/shared";
import type { Candle } from "../broker/types";
import type { StrategyAlgorithm, StrategyDecision, StrategyPositionState } from "./types";

// Confirmed local swing-high/low detection — a TypeScript port of Pine's
// ta.pivothigh(high, lookback, lookback)/ta.pivotlow(low, lookback,
// lookback) (see strategies/btc-high-risk.md Entry logic item 1). A
// candidate bar is confirmed as a pivot high/low once `lookback` further
// bars exist on each side of it and it's the extreme of that whole
// window — the same "lookback bars of confirmation lag, not repainting"
// tradeoff the Pine version documents. Reused for both the 1h feed (which
// also needs the actual Fib levels) and the 4h confirmation feed (which
// only needs direction + zone width) — mirrors how the Pine script shares
// one f_swingInfo-shaped computation between the two timeframes.
class PivotSwingTracker {
  private readonly window: Candle[] = [];
  private barIndex = -1;
  lastHigh: Decimal | null = null;
  lastLow: Decimal | null = null;
  lastHighBar: number | null = null;
  lastLowBar: number | null = null;

  constructor(private readonly lookback: number) {}

  update(candle: Candle): void {
    this.barIndex += 1;
    this.window.push(candle);
    const windowSize = this.lookback * 2 + 1;
    if (this.window.length > windowSize) {
      this.window.shift();
    }
    if (this.window.length < windowSize) {
      return;
    }

    const candidate = this.window[this.lookback];
    const candidateBar = this.barIndex - this.lookback;
    const candidateHigh = toDecimalJs(candidate.high);
    const candidateLow = toDecimalJs(candidate.low);

    // Pine's ta.pivothigh/ta.pivotlow break ties asymmetrically, confirmed
    // via an isolated synthetic test in the Pine Editor (see "Engine port"
    // in strategies/btc-high-risk.md): a candidate tied by a LATER
    // (right-side) bar is disqualified — the later bar effectively "steals"
    // the pivot — but a tie against an EARLIER (left-side) bar does not
    // disqualify it. So left bars allow ties (<=/>=), right bars require
    // strict inequality (</>).  The original version compared the whole
    // window non-strictly, which let it confirm extra pivots (at every tied
    // bar in a run, not just the last) that Pine never confirms — the
    // leading suspect for the ~36% real-trade mismatch found in the
    // pre-iteration-15 parity check.
    let isPivotHigh = true;
    let isPivotLow = true;
    for (let i = 0; i < this.window.length; i++) {
      if (i === this.lookback) {
        continue;
      }
      const h = toDecimalJs(this.window[i].high);
      const l = toDecimalJs(this.window[i].low);
      if (i < this.lookback) {
        if (h.greaterThan(candidateHigh)) isPivotHigh = false;
        if (l.lessThan(candidateLow)) isPivotLow = false;
      } else {
        if (h.greaterThanOrEqualTo(candidateHigh)) isPivotHigh = false;
        if (l.lessThanOrEqualTo(candidateLow)) isPivotLow = false;
      }
    }

    if (isPivotHigh) {
      this.lastHigh = candidateHigh;
      this.lastHighBar = candidateBar;
    }
    if (isPivotLow) {
      this.lastLow = candidateLow;
      this.lastLowBar = candidateBar;
    }
  }

  get hasSwing(): boolean {
    return this.lastHigh !== null && this.lastLow !== null;
  }

  // 1 = last completed leg was low->high (bullish, retracing down from the
  // high); -1 = bearish (retracing up from the low); 0 = tied/unknown.
  get direction(): 1 | -1 | 0 {
    if (this.lastHighBar === null || this.lastLowBar === null) {
      return 0;
    }
    if (this.lastHighBar > this.lastLowBar) {
      return 1;
    }
    if (this.lastLowBar > this.lastHighBar) {
      return -1;
    }
    return 0;
  }

  get zoneWidth(): Decimal | null {
    if (this.lastHigh === null || this.lastLow === null) {
      return null;
    }
    return this.lastHigh.minus(this.lastLow);
  }
}

export interface BtcHighRiskConfig {
  symbol?: string;
  leverage?: number;
  pivotLeftRight?: number;
  minSwingPct?: number;
  minZoneWidth?: number;
  sessionStartHour?: number;
  sessionEndHour?: number;
  // Percentages (e.g. 1.0 = 1%), matching the Pine input defaults —
  // converted to a 0-1 fraction internally.
  riskPct500?: number;
  riskPct786?: number;
  // 0-1 fraction directly (not a percentage like the risk inputs above) —
  // matches the Pine input's own 0-1 range. See iteration 15 in
  // strategies/btc-high-risk.md: winners' 4h candle at entry averaged a
  // 0.635 wick ratio vs losers' 0.549; kept 0.5 there deliberately over a
  // stronger-but-smaller-sample 0.6.
  minWick4hRatio?: number;
}

// The 4h auxiliary feed's tag — see StrategyAlgorithm.onAuxCandle.
export const BTC_HIGH_RISK_AUX_TAG_4H = "240";

// TypeScript port of strategies/btc-high-risk.md's iteration 15 Pine
// script. Ported mechanically from that file — see it for the full
// iteration history, backtest numbers, and reasoning behind each rule.
// Anything below that isn't a direct translation is called out explicitly.
//
// IMPORTANT: this port had an unresolved signal-parity gap against
// iteration 14 (63.8% match rate vs. the real Pine backtest, as of the
// last check). Root-caused one real bug behind it: PivotSwingTracker.update
// compared the whole rolling window non-strictly, but Pine's
// ta.pivothigh/ta.pivotlow break ties asymmetrically (confirmed via an
// isolated synthetic test in the Pine Editor, not just documentation) — a
// candidate tied by a LATER bar is disqualified, a tie against an EARLIER
// bar is not. The non-strict version confirmed extra pivots Pine never
// would, which cascades into different swings/Fib zones/signals downstream.
// Fixed below. This closes one confirmed, real divergence — it has NOT been
// re-verified end-to-end against a fresh Pine trade-list parity check the
// way the original 63.8% number was measured, so treat the gap as narrowed,
// not closed, until that re-check happens. Do not treat this file matching
// the Pine script's *logic* as evidence it matches its *numbers* — see
// "Engine port" in strategies/btc-high-risk.md, and note the
// BTC_HIGH_RISK_ALLOW_LIVE gate in index.ts keeps this off a real account
// regardless.
//
// KNOWN GAPS, not silently papered over — read before trusting this with
// real capital:
//
// 1. The liquidation-tied stop is checked once per closed 1h candle
//    against that candle's high/low, not continuously in real time. The
//    TradingView backtest has the same bar-granularity limitation, so this
//    matches what was actually verified — but a live position sits
//    unprotected between candle closes, and a fast intrabar move could
//    travel most of the way to full liquidation before this process ever
//    sees it. A real deployment should place an actual exchange-side
//    reduceOnly STOP_MARKET order right after entry (Binance futures
//    supports this) so the exchange enforces it continuously even if this
//    process is slow, disconnected, or crashed. That order type doesn't
//    exist in this codebase yet (packages/shared's OrderType is
//    "MARKET" | "LIMIT" only) — building it is a follow-up, not done here.
// 2. Position state (including this.stopPrice) is in-memory only and is
//    lost on a process restart, same documented limitation as
//    StrategyRunner itself. If the engine restarts while a position is
//    open, the stop is not re-derived from the real entry price.
// 3. Pivot detection's tie-breaking rule now matches Pine's confirmed
//    behavior (see the IMPORTANT note above), but the rest of the port
//    still isn't a verified byte-for-byte match — a fresh trade-list parity
//    re-check against the TradingView backtest is still owed before
//    trusting exact parity.
export class BtcHighRiskStrategy implements StrategyAlgorithm {
  readonly slug = "btc-high-risk";
  readonly symbol: string;

  private readonly leverage: number;
  private readonly liqLossFrac: Decimal;
  private readonly minSwingPct: number;
  private readonly minZoneWidth: Decimal;
  private readonly sessionStartHour: number;
  private readonly sessionEndHour: number;
  private readonly riskFraction500: number;
  private readonly riskFraction786: number;
  private readonly minWick4hRatio: number;

  private readonly pivot1h: PivotSwingTracker;
  private readonly pivot4h: PivotSwingTracker;

  // The most recent 4h candle's OHLC, updated by onAuxCandle — used to
  // compute the wick-ratio filter (iteration 15) at 1h decision time. Null
  // until at least one 4h candle has arrived (during warm-up or right
  // after startup).
  private last4hCandle: Candle | null = null;

  // Reconciled against the runner's actual position state at the top of
  // every decide() call, not trusted blindly — if an ENTER signal we
  // emitted didn't actually result in a fill (e.g. risk-blocked, no free
  // capital), we must stop checking a stop level for a position that was
  // never really opened.
  private stopPrice: Decimal | null = null;

  constructor(config: BtcHighRiskConfig = {}) {
    this.symbol = config.symbol ?? "BTCUSDT";
    this.leverage = config.leverage ?? 100;
    this.liqLossFrac = new Decimal(1).div(this.leverage);
    const pivotLeftRight = config.pivotLeftRight ?? 5;
    this.minSwingPct = config.minSwingPct ?? 1.5;
    this.minZoneWidth = new Decimal(config.minZoneWidth ?? 2000);
    this.sessionStartHour = config.sessionStartHour ?? 20;
    this.sessionEndHour = config.sessionEndHour ?? 6;
    this.riskFraction500 = (config.riskPct500 ?? 1.0) / 100;
    this.riskFraction786 = (config.riskPct786 ?? 2.0) / 100;
    this.minWick4hRatio = config.minWick4hRatio ?? 0.5;

    this.pivot1h = new PivotSwingTracker(pivotLeftRight);
    this.pivot4h = new PivotSwingTracker(pivotLeftRight);
  }

  onAuxCandle(tag: string, candle: Candle): void {
    if (tag === BTC_HIGH_RISK_AUX_TAG_4H) {
      this.pivot4h.update(candle);
      this.last4hCandle = candle;
    }
  }

  decide(candle: Candle, position: StrategyPositionState): StrategyDecision {
    if (!position.isOpen) {
      this.stopPrice = null;
    }

    // Indicators update on every candle regardless of whether a stop or
    // entry fires this bar — mirrors Pine evaluating every bar.
    this.pivot1h.update(candle);

    // ---- Liquidation-tied stop — see the KNOWN GAPS note above. ----
    if (position.isOpen && this.stopPrice !== null) {
      const low = toDecimalJs(candle.low);
      const high = toDecimalJs(candle.high);
      if (position.side === "LONG" && low.lessThanOrEqualTo(this.stopPrice)) {
        this.stopPrice = null;
        return { signal: "EXIT_LONG" };
      }
      if (position.side === "SHORT" && high.greaterThanOrEqualTo(this.stopPrice)) {
        this.stopPrice = null;
        return { signal: "EXIT_SHORT" };
      }
    }

    if (!this.pivot1h.hasSwing) {
      return { signal: "HOLD" };
    }

    const high1h = this.pivot1h.lastHigh as Decimal;
    const low1h = this.pivot1h.lastLow as Decimal;
    const diff = high1h.minus(low1h);
    const validSwing = diff.div(low1h).mul(100).greaterThanOrEqualTo(this.minSwingPct);
    if (!validSwing) {
      return { signal: "HOLD" };
    }

    const direction = this.pivot1h.direction;
    const isBullish = direction === 1;
    const isBearish = direction === -1;
    if (!isBullish && !isBearish) {
      return { signal: "HOLD" };
    }

    const fib = (pct: number): Decimal => (isBullish ? high1h.minus(diff.mul(pct)) : low1h.plus(diff.mul(pct)));
    const fib382 = fib(0.382);
    const fib500 = fib(0.5);
    const fib618 = fib(0.618);
    const fib786 = fib(0.786);

    const trend4h = this.pivot4h.direction;
    const zoneWidth4h = this.pivot4h.zoneWidth;
    const validZone4h = zoneWidth4h !== null && zoneWidth4h.greaterThanOrEqualTo(this.minZoneWidth);

    // ---- 4h candle wick-ratio filter (iteration 15) ----
    // Winners' 4h candle at entry showed real rejection (a big wick
    // relative to its range); losers' tended to be a "clean," mostly-body
    // candle fighting the counter-trend Fib entry. validWick4h defaults to
    // false (not true) when no 4h candle has arrived yet, matching "fail
    // closed" for every other confirmation gate here.
    let validWick4h = false;
    if (this.last4hCandle) {
      const o4h = toDecimalJs(this.last4hCandle.open);
      const h4h = toDecimalJs(this.last4hCandle.high);
      const l4h = toDecimalJs(this.last4hCandle.low);
      const c4h = toDecimalJs(this.last4hCandle.close);
      const range4h = h4h.minus(l4h);
      const wick4hRatio = range4h.isZero() ? new Decimal(0) : new Decimal(1).minus(c4h.minus(o4h).abs().div(range4h));
      validWick4h = wick4hRatio.greaterThanOrEqualTo(this.minWick4hRatio);
    }

    const hourUTC = candle.openTime.getUTCHours();
    const inNightSession = hourUTC >= this.sessionStartHour || hourUTC <= this.sessionEndHour;

    const isBullishConfirmed = isBullish && trend4h === 1 && validZone4h && inNightSession && validWick4h;
    const isBearishConfirmed = isBearish && trend4h === -1 && validZone4h && inNightSession && validWick4h;

    const price = toDecimalJs(candle.close);

    // 61.8% (iteration 13) and 38.2% (iteration 14) are dropped entirely —
    // diagnostic logging against the live TradingView backtest found both
    // were the only levels with a profit factor below 1, on two different
    // trade samples. See strategies/btc-high-risk.md Entry logic items
    // 11-12. Only 50.0% and 78.6% remain tradeable.
    if (isBullishConfirmed && position.side !== "LONG") {
      const low = toDecimalJs(candle.low);
      let riskFraction: number | null = null;
      if (low.lessThanOrEqualTo(fib786)) {
        riskFraction = this.riskFraction786;
      } else if (low.lessThanOrEqualTo(fib618)) {
        riskFraction = null;
      } else if (low.lessThanOrEqualTo(fib500)) {
        riskFraction = this.riskFraction500;
      } else if (low.lessThanOrEqualTo(fib382)) {
        riskFraction = null;
      }
      if (riskFraction !== null) {
        this.stopPrice = price.mul(new Decimal(1).minus(this.liqLossFrac));
        return { signal: "ENTER_LONG", riskFraction };
      }
    } else if (isBearishConfirmed && position.side !== "SHORT") {
      const high = toDecimalJs(candle.high);
      let riskFraction: number | null = null;
      if (high.greaterThanOrEqualTo(fib786)) {
        riskFraction = this.riskFraction786;
      } else if (high.greaterThanOrEqualTo(fib618)) {
        riskFraction = null;
      } else if (high.greaterThanOrEqualTo(fib500)) {
        riskFraction = this.riskFraction500;
      } else if (high.greaterThanOrEqualTo(fib382)) {
        riskFraction = null;
      }
      if (riskFraction !== null) {
        this.stopPrice = price.mul(new Decimal(1).plus(this.liqLossFrac));
        return { signal: "ENTER_SHORT", riskFraction };
      }
    }

    return { signal: "HOLD" };
  }
}
