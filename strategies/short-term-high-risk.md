# Short-Term High-Risk

**Status:** draft — written from an interview, not yet run through TradingView's
Strategy Tester. Also **not yet executed by Claude** — unlike the TypeScript
engine code elsewhere in this project (compiled and run live throughout),
there's no TradingView execution environment available here. The multi-stage
scale-out + trailing-stop logic below is the most complex part of this
script and the most likely place for a subtle bug — verify it against
individual trades in the Strategy Tester's trade list, not just the
aggregate P&L, before trusting it.

## Overview

A multi-timeframe (4h regime, 1h confirmation, 15m trigger) trend-continuation
breakout on Binance USDT-M perpetual futures, sized to target 100% profit on
margin via 10-20x leverage on a single short-term move. Deliberately
high-risk by design — the name is literal, not a euphemism. Bounded per-trade
loss (see Stop loss logic) is what keeps "high risk" from meaning "unbounded
risk."

**Symbol universe** (scanner, not a fixed pair): Binance USDT-M futures top-5
24h gainers + top-5 24h losers (by `priceChangePercent` from the public
`GET /fapi/v1/ticker/24hr` endpoint — no API key needed) plus a manually
maintained favorites list, currently **BTCUSDT, PENGUUSDT**. Binance's API
has no endpoint for reading a user's actual favorites/watchlist (confirmed by
search, not assumed) — it's a UI-only preference, so this list has to be
kept in sync by hand, here and in the eventual engine config.

**Important scope note**: the gainers/losers/favorites scanning logic is
described here for completeness, but it is **not, and cannot be, part of the
Pine backtest below**. "Today's top gainers" isn't a stable historical
dataset — there's no way to backtest "would this symbol have been in the top
5 on a given past date" in Pine at all. The Pine script instead validates the
entry/exit/stop/target *mechanics* against one representative symbol
(BTCUSDT). The actual cross-symbol scanning is engine-side (TypeScript) work
for whenever/if this gets promoted, not a Pine Script concern.

## Entry logic

Bidirectional — a confirmed bearish regime enables shorts, not just a bullish
regime enabling longs.

**Long:**
- **4h regime**: EMA(20) > EMA(50) **and** ADX(14) > 25 — confirms a real
  uptrend exists, not just noise.
- **1h confirmation**: 1h close above the 1h EMA(50) — a second filter so a
  4h signal that's already fading doesn't get taken.
- **15m trigger**: close breaks above the highest high of the prior 10 15m
  bars (Donchian-style breakout), **with** 15m volume > 1.5× its 20-bar
  average — favors genuine momentum ignition over a weak, low-conviction
  breakout.

**Short:** exact mirror — 4h EMA(20) < EMA(50) and ADX(14) > 25, 1h close
below 1h EMA(50), 15m closes below the lowest low of the prior 10 bars with
the same volume filter.

## Stop loss logic

**Structural**, using the same lookback window as the entry trigger: for a
long, the stop sits at the low of the same 10-bar range whose high triggered
entry (mirrored above the 10-bar high for shorts) — "if price falls back into
the range it just broke out of, the setup failed."

**Safety cap on top of the structural stop** — this is the part that actually
makes 10-20x leverage survivable: at 20x, liquidation sits roughly 5% away
from entry; at 10x, roughly 10% away (using the simple `1/leverage`
approximation — Pine can't query Binance's actual tiered maintenance-margin
brackets, so this is intentionally conservative, not exact). The maximum
allowed stop distance is capped at **50% of that liquidation distance**:
`0.5 / leverage` as a fraction of entry price (5% at 10x, 2.5% at 20x). **If
the structural stop is wider than this cap, the trade is skipped entirely** —
no entry — rather than take a setup whose invalidation point is effectively
"get liquidated anyway."

One clean consequence of this design: because the cap is defined as a fixed
fraction of the liquidation distance, **the maximum possible loss per trade
is always exactly 50% of the fixed margin (50 USDT of the 100 USDT per
trade), regardless of which leverage between 10x-20x is actually used** —
before fees/slippage.

## Take profit logic

Full target = 100% profit on margin, which requires the price itself to move
`100 / leverage`% (10% at 10x, 5% at 20x).

**Scale-out, not a single all-or-nothing exit:**
1. At **50% of the full target** (price move of `50 / leverage`%): close
   **50% of the position**, and **move the stop to breakeven** (the entry
   price) on the remainder. This was an explicit requirement, not just a
   design choice — once a trade is up more than 50%, it can no longer turn
   into a loss.
2. The remaining 50% of the position exits at either the full 100% target,
   or a **1.5× ATR(14, 15m) trailing stop**, whichever is reached first —
   letting a strong move run past 100% if momentum continues, while locking
   in gains if it stalls.

## Exit rules

No time-based exit — runs until stopped out or the target is hit (including
the breakeven-move and trailing mechanics above). No other discretionary
exit conditions.

## Position sizing

- **Fixed 100 USDT margin per trade**, regardless of symbol or which
  leverage (10-20x) is in use. Notional exposure = margin × leverage (1,000
  - 2,000 USDT).
- **Only one position open at a time**, across the *entire* symbol universe
  (gainers + losers + favorites) — this is a hard constraint the user set
  explicitly. This is naturally already true within the Pine backtest itself
  (a single-symbol Pine strategy can only ever hold one position on its own
  chart), but it's a real open question for the eventual engine-side
  scanner: **what happens when multiple symbols qualify simultaneously?**
  No tie-breaking rule has been decided yet (strongest ADX? highest volume?
  first detected?) — flagged here rather than guessed at, since it doesn't
  affect the Pine backtest but will matter the moment this is promoted.

## Targets

- **Market regime**: deliberately only trades confirmed 4h trending
  conditions (ADX > 25) — sits out ranging/choppy markets entirely by
  design, since a 100%-target move needs genuine directional expansion, not
  routine chop.
- **Performance expectation**: none formally set — explicitly exploratory,
  high-risk/high-reward. The bounded max loss (50 USDT) against the
  unbounded-upside scale-out (100%+ per full-target trade) is the stated
  risk/reward shape; no target win rate or Sharpe ratio has been specified,
  and shouldn't be assumed.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Leverage | 10x | Adjustable 10-20x via input, but see the Pine `margin_long`/`margin_short` note below — those don't move automatically with this input. |
| Fixed margin per trade | 100 USDT | |
| 4h fast EMA | 20 | |
| 4h slow EMA | 50 | |
| 4h ADX length | 14 | |
| 4h ADX trend threshold | 25 | |
| 1h confirmation EMA | 50 | |
| 15m breakout lookback | 10 bars | |
| Volume filter multiplier | 1.5x | vs. 20-bar average volume |
| Stop-loss safety cap | 50% | fraction of the `1/leverage` liquidation-distance approximation |
| TP1 (partial exit + breakeven) | 50% of target | closes 50% of position |
| Trailing stop (post-TP1) | 1.5× ATR(14, 15m) | |
| Max concurrent positions | 1 | across the whole symbol universe |

## Pine Script v6

Multi-timeframe data is pulled via `request.security()` with
`lookahead=barmerge.lookahead_off` to avoid lookahead bias — this is the
standard safe pattern, though some repainting of the *currently forming*
higher-timeframe bar is a known, accepted limitation of MTF Pine scripts in
general, not something fully solvable without confirmed-bar-only techniques
that add significant complexity. Worth knowing about, not something this
script tries to eliminate entirely.

Entries are evaluated on bar close (Pine's default — no
`process_orders_on_close` override needed here). Stop-loss and take-profit
are implemented as native `strategy.exit()` bracket orders, which Pine fills
intrabar against the high/low of each bar — this is the *correct*, realistic
behavior for resting stop/limit orders (unlike entries, which should wait
for a confirmed close, a real stop-loss order on an exchange triggers the
instant price touches it, not at the next candle close).

```pinescript
//@version=6
strategy(
     "Short-Term High-Risk (MTF Breakout)",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 10x leverage (100/10). This is a COMPILE-TIME CONSTANT —
     // Pine does not allow margin_long/margin_short to reference an input
     // variable. If you want to backtest at a different leverage than the
     // "leverage" input's default below, you must edit this literal value
     // too (100/leverage) — changing the input alone does not do this.
     margin_long = 10,
     margin_short = 10,
     commission_type = strategy.commission.percent,
     commission_value = 0.05)

// ---- Inputs ----
leverage         = input.float(10, "Leverage (see margin_long/short note above)", minval = 10, maxval = 20, step = 1)
fixedMarginUSDT  = input.float(100, "Fixed margin per trade (USDT)")
emaFastLen       = input.int(20, "4h fast EMA")
emaSlowLen       = input.int(50, "4h slow EMA")
adxLen           = input.int(14, "4h ADX length")
adxThreshold     = input.float(25, "4h ADX trend threshold")
ema1hLen         = input.int(50, "1h confirmation EMA")
breakoutLookback = input.int(10, "15m breakout lookback (bars)")
volMultiplier    = input.float(1.5, "Volume filter multiplier")
stopCapFraction  = input.float(0.5, "Stop-loss safety cap (fraction of 1/leverage)")
atrLen           = input.int(14, "ATR length (trailing stop)")
atrTrailMult     = input.float(1.5, "ATR multiplier (trailing stop)")

// ---- Higher-timeframe data ----
f_ema(len) => ta.ema(close, len)
f_adx(len) =>
    [_, _, adxVal] = ta.dmi(len, len)
    adxVal

ema20_4h = request.security(syminfo.tickerid, "240", f_ema(emaFastLen), lookahead = barmerge.lookahead_off)
ema50_4h = request.security(syminfo.tickerid, "240", f_ema(emaSlowLen), lookahead = barmerge.lookahead_off)
adx_4h   = request.security(syminfo.tickerid, "240", f_adx(adxLen), lookahead = barmerge.lookahead_off)
ema50_1h = request.security(syminfo.tickerid, "60", f_ema(ema1hLen), lookahead = barmerge.lookahead_off)
close_1h = request.security(syminfo.tickerid, "60", close, lookahead = barmerge.lookahead_off)

// ---- 15m trigger ----
donchianHigh = ta.highest(high[1], breakoutLookback)
donchianLow  = ta.lowest(low[1], breakoutLookback)
volSma20     = ta.sma(volume, 20)
volFilter    = volume > volSma20 * volMultiplier
atrVal       = ta.atr(atrLen)

bullRegime  = ema20_4h > ema50_4h and adx_4h > adxThreshold
bearRegime  = ema20_4h < ema50_4h and adx_4h > adxThreshold
bullConfirm = close_1h > ema50_1h
bearConfirm = close_1h < ema50_1h

longTrigger  = close > donchianHigh and volFilter
shortTrigger = close < donchianLow  and volFilter

longSetup  = bullRegime and bullConfirm and longTrigger
shortSetup = bearRegime and bearConfirm and shortTrigger

// ---- Safety cap ----
maxStopFraction  = stopCapFraction / leverage
longStopDistPct  = (close - donchianLow) / close
shortStopDistPct = (donchianHigh - close) / close
longAllowed      = longStopDistPct  <= maxStopFraction
shortAllowed     = shortStopDistPct <= maxStopFraction

// Fixed margin * leverage / price = base-asset quantity
posQty = (fixedMarginUSDT * leverage) / close

// ---- Position state ----
var float entryPrice = na
var float stopPrice  = na
var float tp1Price   = na
var float tp2Price   = na
var bool  tp1Done     = false

// ---- Entries — only one position at a time ----
if strategy.position_size == 0
    if longSetup and longAllowed
        strategy.entry("Long", strategy.long, qty = posQty)
        entryPrice := close
        stopPrice  := donchianLow
        tp1Price   := close * (1 + 0.5 / leverage)
        tp2Price   := close * (1 + 1.0 / leverage)
        tp1Done    := false
    else if shortSetup and shortAllowed
        strategy.entry("Short", strategy.short, qty = posQty)
        entryPrice := close
        stopPrice  := donchianHigh
        tp1Price   := close * (1 - 0.5 / leverage)
        tp2Price   := close * (1 - 1.0 / leverage)
        tp1Done    := false

// ---- Detect TP1 fill (position shrank but isn't flat) and move stop to breakeven ----
if strategy.position_size != 0 and not tp1Done
    // strategy.exit's own qty_percent fill is what actually reduces size;
    // this flag just tracks that it happened so the second exit call below
    // switches from "structural stop" to "breakeven + trailing".
    if math.abs(strategy.position_size) < math.abs(posQty) * 0.99
        stopPrice := entryPrice
        tp1Done   := true

// ---- Exits: bracket order before TP1, breakeven+trailing runner after ----
if strategy.position_size > 0
    if not tp1Done
        strategy.exit("Bracket-L", from_entry = "Long", qty_percent = 50, limit = tp1Price, stop = stopPrice)
    else
        trailStop = math.max(stopPrice, close - atrVal * atrTrailMult)
        strategy.exit("Runner-L", from_entry = "Long", limit = tp2Price, stop = trailStop)
else if strategy.position_size < 0
    if not tp1Done
        strategy.exit("Bracket-S", from_entry = "Short", qty_percent = 50, limit = tp1Price, stop = stopPrice)
    else
        trailStop = math.min(stopPrice, close + atrVal * atrTrailMult)
        strategy.exit("Runner-S", from_entry = "Short", limit = tp2Price, stop = trailStop)

plot(ema20_4h, "4h EMA20", color = color.blue)
plot(ema50_4h, "4h EMA50", color = color.orange)
plot(donchianHigh, "10-bar High", color = color.green)
plot(donchianLow, "10-bar Low", color = color.red)
```

## Backtest notes

- Run on the **15m chart**, BTCUSDT perpetual futures, on TradingView's
  Strategy Tester.
- **Verify the TP1 → breakeven → trailing transition manually** on at least
  a handful of individual trades in the trade list. The fill-detection logic
  (`strategy.position_size` shrinking below 99% of the original quantity)
  is the part most likely to have an off-by-something issue — confirm it
  actually flips `tp1Done` at the right moment rather than trusting the
  aggregate stats.
- The `margin_long`/`margin_short = 10` literal only simulates 10x. To
  actually test 20x behavior (not just the 20x-adjusted TP/SL math), change
  that literal to `5` as well as the `leverage` input.
- The 1/leverage liquidation-distance approximation ignores Binance's real
  tiered maintenance-margin brackets, which get worse (more conservative)
  at higher notional sizes — this makes the stop-cap slightly optimistic at
  larger position sizes than the 100 USDT default tested here.
- The gainers/losers/favorites symbol universe is not, and cannot be, part
  of this backtest — see the scope note under Overview.

## Next steps

1. Paste into TradingView, confirm it compiles without errors.
2. Manually check several individual trades against the logic above.
3. If it holds up, the next real piece of work is the engine-side scanner
   (top gainers/losers + favorites → candidate selection → tie-breaking rule
   when multiple symbols qualify at once) — not yet designed.
4. This project's engine has **no stop-loss/take-profit order support at
   all** today (`apps/engine`'s `Broker` interface only places market
   entries/exits driven by signals — see `CLAUDE.md`). Promoting this
   strategy into the engine would require building that first, not just
   porting the entry logic.
