# BTC High-Risk

**Status:** draft, iteration 11 — **the first profitable result in this
strategy's entire history** (+$102.36, +10.24%, PF 1.06). See Status detail
below and Backtest results. Iteration 1 (Fibonacci entries + structural/
capped stop + 100%-or-4h-level take profit) was tested in four
configurations, live; every one landed in the same 0.5-0.6 profit-factor
range. Iteration 2 stripped the strategy to entries-only, holding until the
next opposite signal (no stop, no target) — confirmed as the exit style to
keep: avg win/loss came out roughly balanced (+$168.87 / -$185.35), a big
improvement over iteration 1's 5.4:1 imbalance, but still net negative
(-102.01%, PF 0.646, win rate 42.31%). Iteration 3 added a 4h ADX
trend-strength filter to try to fix the win rate — tested live, made it
slightly worse (37.50% win rate, PF 0.596), a real negative result stated
plainly rather than rationalized. Iteration 4 keeps the reversal-hold exit
and drops the ADX filter, but fixes something more fundamental: the swing
used for the Fibonacci levels was the highest-high/lowest-low over a fixed
rolling 72-bar window, which can span multiple unrelated legs and silently
shift every bar as old candles fall out of the window — not an actual
identified "bottom to top" or "top to bottom" move. Replaced with genuine
pivot-based swing detection (confirmed local highs/lows via
`ta.pivothigh`/`ta.pivotlow`), anchoring the Fib levels to one real,
identifiable swing. **Live-verified, best result in this strategy's history
so far**: 58.46% win rate, PF 0.747 — after catching and fixing a real bug
in the trend-direction comparison (see Backtest results) that had the
strategy buying dips through an entire real bear market. Still net negative
overall (-107.37%) because a single -7.69% trade wiped out most of an
otherwise-strong equity curve — the clearest evidence yet that entry quality
isn't the problem, the total absence of a stop loss is.

Following web research into how high-leverage crypto scalpers actually
manage risk (see Backtest results for sources and specifics), iterations 5
and 6 added exactly the two things that research said were missing:
iteration 5 a flat **-1% max-loss stop** (wins still ride to the next
opposite signal; only the loss side is now capped), and iteration 6
**risk-based position sizing** — margin per trade is now derived so that
hitting the stop always costs a fixed % of *current* equity (compounding),
replacing the flat $50-200-regardless-of-account-size table. Both
live-verified together: total return improved to -79.20% (from -107.37%)
and max drawdown improved to 82.83% (from 100%+), but trade count exploded
from 65 to **695** — the pivot-based swing whipsaws rapidly during choppy
stretches, each tiny swing producing its own tiny, immediately-reachable
Fib levels. Iterations 7 and 8 both target that directly and are being
tested together: a **minimum swing size filter** (sit out swings too small
to be worth trading) and **4h trend confirmation** (only trade when the 1h
and 4h pivot-based trend directions agree) — the latter added on direct
request while iteration 7 was still being written up. **Live-verified
together**: trade count fell from 695 to **192** (both filters doing real
work cutting noise), total return improved to -50.02% (from -79.20%), max
drawdown improved to 56.78% (from 82.83%) — but win rate fell further to
34.90%. The payoff ratio is now genuinely favorable (avg win $20.08 vs avg
loss -$14.77, ~1.36:1) — this needs roughly 42% win rate to break even, and
34.90% isn't there yet, but it's closer than any version before it.

Iteration 9 tried adding EMA(9/21) + VWAP confluence on top, per the web
research cited in Backtest results (real short-term setups trade Fibonacci
as one leg of confluence, not alone). **Tested live and made things much
worse** — win rate fell to 17.65%, PF to 0.272 — likely because requiring
price above VWAP and EMA9>EMA21 for a long directly contradicts the Fib
logic's whole premise (buying a pullback means price has already dropped
below recent structure, which tends to coincide with EMA9 dipping below
EMA21 and price sitting below VWAP — exactly what the filter rejected). A
real negative result, stated plainly rather than rationalized. **Reverted**
— iteration 8 (no confluence gate) is the current baseline.

Iteration 10 adds a **minimum 4h zone width** check on top of iteration
8: the 4h pivot high-to-low range is now also required to be at least
`minZoneWidth` (default $2000) before a trade is allowed, on the theory
that a narrow 4h range signals an indecisive market rather than a real
trending structure. **Live-verified — a modest, mixed result**: trades
fell further (192→163), total return and drawdown both improved slightly
(-50.02%→-45.14%, 56.78%→54.02%), and the payoff ratio actually improved
to ~1.68:1 (avg win $24.06 vs avg loss -$14.31) — but win rate fell to
30.06% (from 34.90%), landing at roughly the same distance from its
now-higher breakeven point (~37.3%). Net effect: a lateral move, not a
clear win like iterations 7-8 were.

Rather than tune another filter blind, went back to diagnosing real trade
data (the same technique that found `short-term-high-risk`'s session
filter): added temporary `log.info()` diagnostics to iteration 10 and
cross-referenced all 164 signals against outcome. ADX and 4h zone width
showed no separation between winners and losers. Two real patterns did:
the 61.8% Fib level had a 16.7% win rate vs. 38.2%'s 40% (not yet acted
on), and — the big one — **night-session trades (20:00-06:00 UTC) were
profitable (+$82.5) while day-session trades (07:00-19:00 UTC) accounted
for essentially the entire loss (-$534.0)**. Note this is the *opposite*
session from `short-term-high-risk`'s finding — different symbol,
timeframe, and mechanism, no contradiction, just worth not assuming one
strategy's session pattern transfers to another.

**Iteration 11 adds a night-session-only filter** (20:00-06:00 UTC) on top
of iteration 10. **Live-verified: +$102.36 (+10.24%), PF 1.06, 23.23% win
rate (23/99), max drawdown 29.37%** — the first profitable configuration
in this strategy's entire history. Avg win $62.10 vs avg loss -$18.27 (a
~3.4:1 payoff ratio) needs only ~22.7% win rate to break even, and 23.23%
clears it. Real, but a thin margin on one BTCUSDT window — not yet
re-verified elsewhere.

## Overview

Single-symbol BTCUSDT.P, **100x leverage**, entries driven by Fibonacci
retracement levels against a dynamically-detected 1h trend. No exit logic
exists except reversal — a new signal in the opposite direction closes the
existing position and opens the new one (the same idiom `ma-cross-demo.md`
uses), and a repeat signal in the same direction is a no-op (Pine's default
no-pyramiding behavior blocks a duplicate same-side entry). This makes the
backtest a direct measure of "was this entry timing right, held until the
next opposing signal" — not entangled with any particular stop or target
design.

## Entry logic

1. **Swing detection (iteration 4 — pivot-based, not a rolling window)**:
   uses `ta.pivothigh`/`ta.pivotlow` on the 1h chart (`pivotLeftRight` bars
   of confirmation on each side, default 5) to find genuine, confirmed local
   swing points, and tracks the most recent confirmed pivot high and pivot
   low. This replaced iteration 1-3's approach (highest-high/lowest-low over
   a fixed rolling 72-bar window), which could span multiple unrelated legs
   and would silently shift the levels every bar as old candles aged out of
   the window — not an actual identified "bottom to top" or "top to bottom"
   move. Pivot detection introduces `pivotLeftRight` bars of confirmation
   lag (can't know a pivot happened until that many bars pass) — an honest,
   bounded delay, not repainting.
2. **Trend direction**: whichever of the two most recent confirmed pivots is
   more recent determines the leg. Pivot low more recent than pivot high →
   the last completed leg was low→high (an up-move) → **bullish**, price
   presumed retracing down from that high. Pivot high more recent → the last
   leg was high→low (a down-move) → **bearish**, retracing up from that low.
3. **Fibonacci levels** — 38.2%, 50%, 61.8%, 78.6% — computed down from the
   pivot high (bullish) or up from the pivot low (bearish), same formula as
   before, just anchored to real pivots now instead of window extremes.
4. **Entry trigger**: on a bullish trend, if the bar's low touches a Fib
   level, go long, sized per that level (see Position sizing) — checked
   deepest level first so a gap through multiple levels enters at the
   deepest one actually reached. Bearish is the exact mirror (bar's high
   against the same levels, go short).
5. No trend-strength filter — iteration 3's ADX filter was tested and made
   results slightly worse, dropped. No session filter.
6. **Minimum swing size (iteration 7)**: only trades a
   swing if the pivot-high-to-pivot-low range is at least `minSwingPct`% of
   price. Added after iterations 5-6 (stop-loss + risk-based sizing) drove
   trade count from 65 to 695 — the pivot detector whipsaws rapidly during
   choppy stretches, each tiny swing producing its own tiny,
   immediately-reachable Fib levels, and the user flagged the resulting
   pile of near-breakeven trades directly. This filter sits out swings too
   small to be worth trading rather than trying to fix it after the fact.
7. **4h trend confirmation (iteration 8)**: computes
   the same pivot-based trend direction independently on the 4h timeframe
   (via `request.security`) and only allows a trade when the 1h and 4h
   trend agree — a 1h bullish retracement setup is skipped if the 4h
   pivots currently read bearish, and vice versa. Directly requested to cut
   trade count/noise further by requiring both timeframes to actually
   agree, not just the 1h swing in isolation.
8. **EMA/VWAP confluence — attempted in iteration 9, reverted.** Tried
   requiring EMA(9) > EMA(21) and close above the session VWAP for a long
   (mirror for short), on the theory that real short-term crypto setups
   trade Fibonacci as one leg of confluence rather than alone. Made results
   much worse live (win rate 34.90%→17.65%, PF 0.729→0.272) — the filter
   likely rejects exactly the pullback entries the Fib logic is designed to
   catch, since a real dip tends to coincide with EMA9 briefly below EMA21
   and price below VWAP. Not carried forward — see Backtest results.
9. **Minimum 4h zone width (iteration 10)**: the 4h
   pivot high-to-low range from iteration 8's trend confirmation is now
   also checked as a support/resistance zone width — if that range is
   narrower than `minZoneWidth` (default $2000), the trade is skipped even
   if direction and the 1h Fib level otherwise line up. A tight 4h zone
   means the market is in an indecisive, narrow range rather than a
   meaningful trending structure — directly requested to cut further
   low-quality trades that iterations 7-8's filters still let through.
10. **Night session only (iteration 11)**: only trades 20:00-06:00 UTC.
    Found by diagnostic logging (not theorized) — night-session signals were
    profitable (+$82.5) while day-session signals accounted for essentially
    the entire loss (-$534.0) on the same 164-signal sample. First filter in
    this strategy's history to flip the whole backtest profitable.

## Stop loss logic

**Flat -1% max-loss stop** (iteration 5), set at entry and never adjusted:
long stop = `entryClose × (1 − maxLossPct/100)`, short is the mirror. This
does not replace the reversal exit for winners — it only caps the loss
side. Added directly in response to iteration 4's single -7.69% trade
wiping out most of an otherwise-strong equity curve, and matches what web
research on real high-leverage scalping practice recommends: cap the
stop-out cost at a fixed, small amount rather than letting it float with
market structure (see Backtest results for sources).

## Take profit logic

**None** — wins still ride until the next opposite signal (reversal-only),
unchanged from iteration 2's finding that this produces a better payoff
ratio than a nearby fixed/structural target.

## Exit rules

- **Stop-loss** (iteration 5): a `-maxLossPct`% adverse move from entry
  closes the position immediately.
- A signal in the **opposite** direction from the current position closes
  it and opens the new one (Pine's standard reversal behavior when
  `strategy.entry()` is called for the other side) — this is still how
  winners exit.
- A signal in the **same** direction as an already-open position is a
  no-op — Pine's default `pyramiding=0` blocks a duplicate same-side entry.
- No time-based exit, no take-profit target.

## Position sizing

- **Leverage: 100x**, fixed.
- **Risk-based sizing (iteration 6)**, replacing iteration 1-5's flat
  $50-200 table: margin per trade is derived so that hitting the max-loss
  stop always costs a fixed **% of current equity** (compounding), not a
  fixed dollar amount regardless of account size —
  `margin = (equity × riskPct / 100) / (leverage × maxLossPct / 100)`.
  riskPct still scales with which Fib level triggered entry (deeper
  retracement = more risk budget):

  | Level | Risk % of equity |
  |---|---|
  | 38.2% | 0.5% |
  | 50.0% | 1.0% |
  | 61.8% | 1.5% |
  | 78.6% | 2.0% |

- Notional exposure = margin × 100.

## Targets

- **Market regime**: trades with whichever 1h trend the most recent pivot
  pair implies, gated by minimum swing size (iteration 7), 4h zone width
  (iteration 10), and now restricted to the 20:00-06:00 UTC session
  (iteration 11) — no trend-strength filter (iteration 3's ADX gate was
  tested and dropped).
- **Performance expectation**: the first iteration where this is
  meaningful — iteration 11 is net profitable (+10.24%, PF 1.06) on the
  one BTCUSDT window tested. Still exploratory; not yet re-verified on a
  different range or symbol.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Leverage | 100x | Fixed |
| Pivot confirmation (bars each side) | 5 | iteration 4 |
| Max loss per trade (% price move) | 1.0% | iteration 5 |
| Minimum swing size (% of price) | 1.5% | iteration 7 |
| Risk % of equity at 38.2% | 0.5% | iteration 6 |
| Risk % of equity at 50.0% | 1.0% | iteration 6 |
| Risk % of equity at 61.8% | 1.5% | iteration 6 |
| Risk % of equity at 78.6% | 2.0% | iteration 6 |
| Min 4h zone width ($) | $2000 | iteration 10 |
| Session start hour (UTC) | 20 | iteration 11 |
| Session end hour (UTC) | 6 | iteration 11 |

## Pine Script v6

Runs on the **1h chart**. One `request.security` call (iteration 8) pulls
the same pivot-based trend logic (plus zone width, iteration 10) computed
independently on the 4h timeframe, with `lookahead=barmerge.lookahead_off`
(the same safe pattern `short-term-high-risk` uses).

```pinescript
//@version=6
strategy(
     "BTC High-Risk",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 100x leverage (100/100 = 1). COMPILE-TIME CONSTANT — Pine
     // does not allow margin_long/margin_short to reference an input
     // variable, so this literal must be hand-edited if leverage changes.
     margin_long = 1,
     margin_short = 1,
     commission_type = strategy.commission.percent,
     commission_value = 0.05)

// ---- Inputs ----
leverage         = input.float(100, "Leverage (see margin_long/short note above)", minval = 1, maxval = 125, step = 1)
pivotLeftRight   = input.int(5, "Pivot confirmation (bars each side)")
maxLossPct       = input.float(1.0, "Max loss per trade (% price move, iteration 5)")
minSwingPct      = input.float(1.5, "Minimum swing size to trade (% of price, iteration 7)")
riskPct382       = input.float(0.5, "Risk % of equity at 38.2% (iteration 6)")
riskPct500       = input.float(1.0, "Risk % of equity at 50.0% (iteration 6)")
riskPct618       = input.float(1.5, "Risk % of equity at 61.8% (iteration 6)")
riskPct786       = input.float(2.0, "Risk % of equity at 78.6% (iteration 6)")
minZoneWidth     = input.float(2000, "Min 4h zone width ($) to allow a trade (iteration 10)")
sessionStartHour = input.int(20, "Session start hour (UTC, inclusive, iteration 11)")
sessionEndHour   = input.int(6, "Session end hour (UTC, inclusive, iteration 11)")

// ---- Pivot-based swing detection (iteration 4) ----
// Replaces iteration 1-3's ta.highest/ta.lowest-over-a-fixed-window approach,
// which could span multiple unrelated legs and would silently shift the
// levels every bar as old candles aged out of the window. This anchors the
// Fib levels to one real, confirmed swing instead.
ph = ta.pivothigh(high, pivotLeftRight, pivotLeftRight)
pl = ta.pivotlow(low, pivotLeftRight, pivotLeftRight)

var float lastPivotHigh    = na
var float lastPivotLow     = na
var int   lastPivotHighBar = na
var int   lastPivotLowBar  = na

if not na(ph)
    lastPivotHigh    := ph
    lastPivotHighBar := bar_index - pivotLeftRight
if not na(pl)
    lastPivotLow    := pl
    lastPivotLowBar := bar_index - pivotLeftRight

haveSwing = not na(lastPivotHigh) and not na(lastPivotLow)
diff      = lastPivotHigh - lastPivotLow

// Minimum swing size filter (iteration 7): the pivot detector can whipsaw
// rapidly during choppy stretches, each tiny alternating swing producing
// its own tiny, immediately-reachable Fib levels -- verified live as the
// cause of trade count exploding from 65 (iteration 4) to 695 (iteration
// 6) once a stop-loss let positions close and re-enter quickly instead of
// only ever exiting on a slow opposite-signal reversal. This sits out any
// swing too small to be worth trading at all.
validSwing = haveSwing and (diff / lastPivotLow * 100) >= minSwingPct

// Pivot high more recent (LARGER bar_index, since bar_index counts forward)
// than pivot low -> last completed leg was low->high (an up-move) ->
// bullish, now presumed retracing down from that high.
//
// Real bug caught live testing this: a first version compared these the
// same way iteration 1-3's ta.highestbars/ta.lowestbars version did
// ("lastPivotLowBar > lastPivotHighBar" for bullish) without noticing that
// ta.highestbars/lowestbars return a "bars ago" count (LARGER = OLDER),
// while bar_index is an absolute index (LARGER = MORE RECENT) -- the
// opposite direction. That inverted version called a sustained downtrend
// "bullish" the whole way down, and the backtest showed exactly that: 8
// months of real BTCUSDT decline (Jan-Sep 2026, ~93k to ~80k) produced a
// strategy that kept trying to buy dips in a bear market (PF 0.04).
// Comparison direction fixed below.
isBullish = validSwing and lastPivotHighBar > lastPivotLowBar
isBearish = validSwing and lastPivotLowBar > lastPivotHighBar

fib382 = isBullish ? lastPivotHigh - diff * 0.382 : lastPivotLow + diff * 0.382
fib500 = isBullish ? lastPivotHigh - diff * 0.5   : lastPivotLow + diff * 0.5
fib618 = isBullish ? lastPivotHigh - diff * 0.618 : lastPivotLow + diff * 0.618
fib786 = isBullish ? lastPivotHigh - diff * 0.786 : lastPivotLow + diff * 0.786

// ---- 4h trend confirmation (iteration 8) + zone width (iteration 10) ----
// Same pivot-based direction logic, computed independently on the 4h
// timeframe. A trade only fires when the 1h and 4h reads agree -- directly
// requested to cut noise further by requiring both timeframes to actually
// agree, not just the 1h swing in isolation. Also returns the 4h pivot
// high-to-low range as a support/resistance zone width (iteration 10) --
// a trade is skipped if that zone is narrower than minZoneWidth, on the
// theory that a tight 4h range signals an indecisive market rather than a
// real trending structure.
f_swingInfo(len) =>
    ph2 = ta.pivothigh(high, len, len)
    pl2 = ta.pivotlow(low, len, len)
    var float lastPH2    = na
    var float lastPL2    = na
    var int   lastPH2Bar = na
    var int   lastPL2Bar = na
    if not na(ph2)
        lastPH2    := ph2
        lastPH2Bar := bar_index - len
    if not na(pl2)
        lastPL2    := pl2
        lastPL2Bar := bar_index - len
    dir = (na(lastPH2) or na(lastPL2)) ? 0 : (lastPH2Bar > lastPL2Bar ? 1 : (lastPL2Bar > lastPH2Bar ? -1 : 0))
    zoneWidth = (na(lastPH2) or na(lastPL2)) ? na : (lastPH2 - lastPL2)
    [dir, zoneWidth]

[trend4h, zoneWidth4h] = request.security(syminfo.tickerid, "240", f_swingInfo(pivotLeftRight), lookahead = barmerge.lookahead_off)

validZone4h = not na(zoneWidth4h) and zoneWidth4h >= minZoneWidth

// EMA/VWAP confluence was tried here (iteration 9) and reverted -- it made
// win rate and profit factor much worse (see Backtest results). Requiring
// price above VWAP and EMA9>EMA21 for a long directly contradicts buying a
// Fib pullback, which by definition means price already dropped below
// recent structure.

// ---- Session filter (iteration 11) ----
// Found by diagnostic logging (not theorized) across all 164 of iteration
// 10's trade signals: night-session trades (20:00-06:00 UTC) were
// profitable (+$82.5) while day-session trades (07:00-19:00 UTC)
// accounted for essentially the entire loss (-$534.0) -- see Backtest
// results. First filter in this strategy's history to flip the whole
// backtest profitable.
barHourUTC  = hour(time, "UTC")
inNightSess = barHourUTC >= sessionStartHour or barHourUTC <= sessionEndHour

isBullishConfirmed = isBullish and trend4h == 1 and validZone4h and inNightSess
isBearishConfirmed = isBearish and trend4h == -1 and validZone4h and inNightSess

// ---- Position state ----
var float stopPrice = na

// ---- Risk-based position sizing (iteration 6) ----
// Margin per trade is derived so that hitting the max-loss stop always
// costs exactly riskPct% of CURRENT equity (compounding), instead of a
// fixed dollar amount regardless of account size:
//   dollar loss at stop  ~=  margin * leverage * (maxLossPct / 100)
//   margin = (equity * riskPct / 100) / (leverage * maxLossPct / 100)
f_marginForRisk(riskPct) =>
    riskAmount = strategy.equity * riskPct / 100
    riskAmount / (leverage * maxLossPct / 100)

// ---- Entries: reversal-based, plus a flat max-loss stop (iteration 5) ----
// Gated on the *confirmed* (1h+4h agreeing) signals (iteration 8); fib
// levels themselves still come from the 1h swing computed above.
if isBullishConfirmed
    float entryRiskPct = na
    if low <= fib786
        entryRiskPct := riskPct786
    else if low <= fib618
        entryRiskPct := riskPct618
    else if low <= fib500
        entryRiskPct := riskPct500
    else if low <= fib382
        entryRiskPct := riskPct382
    if not na(entryRiskPct)
        margin = f_marginForRisk(entryRiskPct)
        qty = (margin * leverage) / close
        strategy.entry("Long", strategy.long, qty = qty)
        stopPrice := close * (1 - maxLossPct / 100)
else if isBearishConfirmed
    float entryRiskPct = na
    if high >= fib786
        entryRiskPct := riskPct786
    else if high >= fib618
        entryRiskPct := riskPct618
    else if high >= fib500
        entryRiskPct := riskPct500
    else if high >= fib382
        entryRiskPct := riskPct382
    if not na(entryRiskPct)
        margin = f_marginForRisk(entryRiskPct)
        qty = (margin * leverage) / close
        strategy.entry("Short", strategy.short, qty = qty)
        stopPrice := close * (1 + maxLossPct / 100)

// ---- Exits: max-loss stop only -- wins still ride until the opposite signal ----
if strategy.position_size > 0
    strategy.exit("SL-L", from_entry = "Long", stop = stopPrice)
else if strategy.position_size < 0
    strategy.exit("SL-S", from_entry = "Short", stop = stopPrice)

plot(fib382, "Fib 38.2%", color = color.yellow)
plot(fib500, "Fib 50%", color = color.orange)
plot(fib618, "Fib 61.8%", color = color.red)
plot(fib786, "Fib 78.6%", color = color.maroon)
plot(lastPivotHigh, "Swing High", color = color.green)
plot(lastPivotLow, "Swing Low", color = color.blue)
```

## Backtest notes

- Run on the **1h chart**, BTCUSDT.P, on TradingView's Strategy Tester.
- **Since iteration 5, a flat -1% stop exists**, but Pine still doesn't
  simulate real exchange liquidation — at 100x, liquidation sits roughly 1%
  from entry too (before fees, the usual `1/leverage` approximation), so
  the coded stop and the real liquidation point are close enough together
  that fees/slippage/funding could still mean the exchange gets there
  first in reality. Treat backtest numbers as directionally informative,
  not as a guaranteed real-account outcome.
- Position size (qty) is risk-based since iteration 6 (a % of current
  equity, not a fixed dollar table), so dollar P&L now compounds with
  account size — expect the numbers to look different in scale from
  iterations 1-4, that's the sizing model doing its job, not a bug.
- The pivot-based swing (iteration 4) only updates when a NEW pivot is
  confirmed — a real improvement over iterations 1-3's every-bar window
  shift, but it means the levels can go a long time without updating during
  a strongly one-directional move (no opposing pivot forms), and there's a
  `pivotLeftRight`-bar delay before a new pivot is recognized at all. Worth
  watching on the chart to confirm the plotted swing high/low actually track
  real turning points, not stale ones.

## Backtest results (iteration 4, live-verified)

**First pass had a real bug**: the trend-direction comparison was ported
from iteration 1-3's `ta.highestbars`/`ta.lowestbars` ("bars ago" — larger
means OLDER) without flipping direction for `bar_index` (an absolute index
— larger means MORE RECENT). Result: `isBullish` stayed true continuously
through an 8-month real BTCUSDT decline (Jan–Sep 2026, ~93k→~80k) because
pivot lows kept being the most recently confirmed point, which the buggy
comparison read as "bullish" — the strategy spent the whole test trying to
buy dips in a bear market, went completely flat after Jan 9 (only 8 trades
total), PF 0.04.

**Fixed comparison, same date range:**

| Metric | Value |
|---|---|
| Total PnL | -$1,073.66 (-107.37%) |
| Win rate | **58.46% (38/65)** |
| Profit factor | 0.747 |
| Avg win | +$83.54 |
| Avg loss | -$132.79 |
| Biggest loss | **-$1,538.33 (-7.69%)** |

Genuinely good entry logic this time — win rate jumped to 58%, and the
equity curve climbed to roughly +$1,600 before collapsing. **One single
trade** (-$1,538.33 — held without any stop through a large adverse move,
since this version still has zero risk management) erased most of the
accumulated gains and pushed the total net negative. This is the clearest
evidence yet in this strategy's history that the entry logic itself has
real edge — the failure mode is entirely "no stop loss at 100x leverage
lets one bad hold destroy everything," not bad entries.

**Iterations 5-6 (flat -1% stop + risk-based sizing), same date range:**
motivated by web research into how high-leverage crypto scalpers actually
manage risk — search terms and specifics below.

| Metric | Value |
|---|---|
| Total PnL | -$791.96 (-79.20%) |
| Win rate | 46.33% (322/695) |
| Profit factor | 0.705 |
| Max drawdown | 82.83% |

Research findings that drove this: real scalpers size positions so a full
stop-out costs only 0.25-0.5% of equity, using *effective* leverage of
5-10x "not the maximum the platform allows" — the exchange's 100x ceiling
and your actual risk are different things ([KuCoin risk management
guide](https://www.kucoin.com/blog/crypto-futures-risk-management-2026)).
Standard position-sizing formula: decide risk % and stop distance first,
then size the position to fit — `margin = (equity × risk%) / (leverage ×
stopDistance%)` — leverage only changes margin required, not how much
should be risked ([Kraken position sizing
guide](https://www.kraken.com/tw/learn/futures-trading-position-sizing-leverage),
[BloFin position sizing
guide](https://blofin.com/en/academy/education/position-sizing-in-crypto)).
Both implemented directly: total return and drawdown both improved
substantially over iteration 4, but **trade count exploded from 65 to
695** — the pivot detector whipsaws during choppy stretches, each tiny
swing producing its own tiny, immediately-touchable Fib levels, and once a
stop let positions close quickly (instead of only ever waiting for a slow
opposite-signal reversal) that whipsaw could re-enter and re-exit rapidly.
The user caught this directly from the pile of near-breakeven trades.

**Iterations 7-8 (minimum swing size + 4h trend confirmation), same date
range:**

| Metric | Value |
|---|---|
| Total PnL | -$500.20 (-50.02%) |
| Win rate | 34.90% (67/192) |
| Profit factor | 0.729 |
| Max drawdown | 56.78% |
| Avg win / avg loss | +$20.08 / -$14.77 (~1.36:1) |

Trade count fell from 695 to 192 — both filters doing real work. Total
return and drawdown both improved again. The payoff ratio is now genuinely
favorable (~1.36:1, needs only ~42% win rate to break even) but win rate
sits at 34.90% — closer than any prior version, still short. Research also
flagged that real short-term crypto setups typically use **confluence**
(Fibonacci + VWAP + EMA together, not Fibonacci alone) and operate on much
faster 1-5 minute charts with 0.25-0.5% targets ([Cryptowisser Fib/VWAP/EMA
confluence
guide](https://www.cryptowisser.com/guides/fibonacci-vwap-ema-crypto-scalping/),
[Mudrex scalping
strategies](https://mudrex.com/learn/crypto-futures-scalping-strategies/))
— neither has been tried yet; see Next steps.

**Iteration 9 (EMA/VWAP confluence, attempted and reverted), same date
range:**

| Metric | Value |
|---|---|
| Total PnL | -$262.30 (-26.23%) |
| Win rate | **17.65% (9/51)** |
| Profit factor | **0.272** |
| Max drawdown | 26.23% |

Requiring EMA(9)>EMA(21) and close above VWAP for a long (mirror for
short) cut trade count sharply (192→51) but win rate and profit factor
both collapsed. Total dollar loss looks smaller only because far fewer,
much smaller trades were taken — this is not an improvement, it's the
filter rejecting most of the setups that used to work. **Reverted** — see
Entry logic and Status for the likely mechanism (the filter contradicts
buying a pullback by construction).

**Iteration 10 (minimum 4h zone width), same date range, built on
iteration 8 (not 9):**

| Metric | Value |
|---|---|
| Total PnL | -$451.37 (-45.14%) |
| Win rate | 30.06% (49/163) |
| Profit factor | 0.723 |
| Max drawdown | 54.02% |
| Avg win / avg loss | +$24.06 / -$14.31 (~1.68:1) |

A lateral move, not a clear improvement: trade count fell further
(192→163), total return and drawdown both improved slightly, and the
payoff ratio actually got better (~1.68:1, best of any iteration so far) —
but win rate fell to 30.06%, landing about the same distance from its
now-higher breakeven point (~37.3%) as iteration 8 was from its own
(~42%). Worth keeping as a real, if modest, refinement, but not the
win-rate breakthrough iteration 9 was meant to be (and wasn't).

**Diagnostic pass on iteration 10 (164 signals) — same technique that found
`short-term-high-risk`'s session filter**: added temporary `log.info()`
capturing hour, day-of-week, 4h ADX, 4h zone width, volume ratio, and which
Fib level triggered each entry; cross-referenced against actual outcome.

- **ADX and 4h zone width**: no separation between winners and losers —
  stated plainly as a null result, same as it was for `short-term-high-risk`.
- **Fib level**: 38.2% ran a 40.0% win rate (14/35); 61.8% ran only 16.7%
  (5/30) — a real, not-yet-acted-on pattern (61.8% is currently sized as a
  *larger* risk allocation despite being the weakest level).
- **Session — the standout finding**: night (20:00-06:00 UTC) ran +$82.5
  total on the 164 signals; day (07:00-19:00 UTC) ran -$534.0 — day-session
  trades accounted for essentially the entire loss. Note this is the
  *opposite* session from `short-term-high-risk`'s finding; different
  symbol/timeframe/mechanism, not a contradiction.

**Iteration 11 (night-session-only filter, 20:00-06:00 UTC), same date
range:**

| Metric | Value |
|---|---|
| Total PnL | **+$102.36 (+10.24%)** |
| Win rate | 23.23% (23/99) |
| Profit factor | **1.06** |
| Max drawdown | 29.37% |
| Avg win / avg loss | +$62.10 / -$18.27 (~3.4:1) |

**The first profitable configuration in this strategy's entire history.**
Win rate is the lowest of any iteration, but the payoff ratio (~3.4:1) more
than compensates — breakeven at that ratio is ~22.7%, and 23.23% clears it.
Real, live-verified, but a thin margin on one BTCUSDT window (Jan-Sep
2026) — not yet re-verified on a different range or symbol, and small
enough that normal sample variance could erase it.

## Next steps

1. **Re-verify on a different date range or symbol** before trusting this
   margin — a ~$100 edge over 99 trades on one window is real progress, not
   proof. This is the single most important unfinished check.
2. **Act on the 61.8% level finding**: either drop that level entirely or
   reduce its risk allocation (currently 1.5%, one of the larger sizes,
   despite the worst win rate of any level at 16.7%).
3. Iteration 9 showed that naive trend-confluence (EMA/VWAP requiring price
   already past a breakout) actively fights the Fib pullback logic. Any
   future confluence attempt needs to check *momentum turning*, not just
   trend alignment — e.g. price reclaiming the fast EMA from below on the
   bounce, not already being above it.
4. Consider whether the 1h/4h timeframe pair is fundamentally mismatched
   with 100x leverage — real scalping research points to 1-5 minute charts
   with 0.25-0.5% targets, not multi-hour swing holds. Not tested this
   session.
5. Re-verify iteration 3's ADX-filter result under the now-fixed swing
   logic — it was tested against the buggy trend direction, so that result
   is no longer trustworthy either way.
6. Investigate the -3.95% biggest-loss outlier under the -1% stop (iteration
   8's List of Trades) — likely a real gap-through-the-stop case given 1h
   BTC candle size, not a bug, but worth a quick check before assuming so.
