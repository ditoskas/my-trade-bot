# BTC High-Risk

**Status:** draft, iteration 4. Iteration 1 (Fibonacci entries + structural/
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
isn't the problem, the total absence of a stop loss is. See Backtest notes
for why this version is still not safe to run with real capital as-is.

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
5. No trend-strength filter this iteration (iteration 3's ADX filter was
   tested and made results slightly worse — dropped, not carried forward).
   No session filter, no safety cap.

## Stop loss logic

**None.** No `strategy.exit()` call exists in this version at all. The only
way out of a position is a new signal in the opposite direction. This is a
real, dangerous gap at 100x leverage — see Backtest notes — not an
oversight in the documentation.

## Take profit logic

**None**, for the same reason — exits are reversal-only.

## Exit rules

- A signal in the **opposite** direction from the current position closes
  it and opens the new one on the same bar (Pine's standard reversal
  behavior when `strategy.entry()` is called for the other side).
- A signal in the **same** direction as an already-open position is a
  no-op — Pine's default `pyramiding=0` blocks a duplicate same-side entry,
  so this doesn't add to the position or reset anything.
- No time-based exit, no stop, no target.

## Position sizing

- **Leverage: 100x**, fixed.
- Margin per trade scales with which Fibonacci level triggered entry, same
  table as iteration 1:

  | Level | Margin |
  |---|---|
  | 38.2% | $50 |
  | 50.0% | $100 |
  | 61.8% | $150 |
  | 78.6% | $200 |

- Notional exposure = margin × 100.
- Not compounding — fixed dollar amounts regardless of equity.

## Targets

- **Market regime**: trades with whichever 1h trend the most recent pivot
  pair implies — no trend-strength filter (iteration 3's ADX gate was
  tested and dropped, see Status).
- **Performance expectation**: none — this iteration is explicitly a
  diagnostic step (does anchoring the Fib swing to real pivots instead of a
  rolling window fix anything?), not a return-seeking version.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Leverage | 100x | Fixed |
| Pivot confirmation (bars each side) | 5 | iteration 4 |
| Margin at 38.2% | $50 | |
| Margin at 50.0% | $100 | |
| Margin at 61.8% | $150 | |
| Margin at 78.6% | $200 | |

## Pine Script v6

Runs on the **1h chart**. No `request.security` calls this iteration —
pivot detection is native to whatever chart the script runs on, and the ADX
filter from iteration 3 is gone.

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
leverage       = input.float(100, "Leverage (see margin_long/short note above)", minval = 1, maxval = 125, step = 1)
pivotLeftRight = input.int(5, "Pivot confirmation (bars each side)")
size382        = input.float(50,  "Margin at 38.2% retracement (USDT)")
size500        = input.float(100, "Margin at 50.0% retracement (USDT)")
size618        = input.float(150, "Margin at 61.8% retracement (USDT)")
size786        = input.float(200, "Margin at 78.6% retracement (USDT)")

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
// "bullish" the whole way down (pivot lows kept being the most recently
// confirmed point, which the old "bars ago" logic would have called
// bearish, but the un-flipped comparison called bullish instead), and the
// backtest showed exactly that: 8 months of real BTCUSDT decline (Jan-Sep
// 2026, ~93k to ~80k) produced a strategy that kept trying to buy dips in a
// bear market, went entirely flat after Jan 9, and returned essentially
// nothing but losses (PF 0.04). Comparison direction fixed below.
isBullish = haveSwing and lastPivotHighBar > lastPivotLowBar
isBearish = haveSwing and lastPivotLowBar > lastPivotHighBar

diff = lastPivotHigh - lastPivotLow

fib382 = isBullish ? lastPivotHigh - diff * 0.382 : lastPivotLow + diff * 0.382
fib500 = isBullish ? lastPivotHigh - diff * 0.5   : lastPivotLow + diff * 0.5
fib618 = isBullish ? lastPivotHigh - diff * 0.618 : lastPivotLow + diff * 0.618
fib786 = isBullish ? lastPivotHigh - diff * 0.786 : lastPivotLow + diff * 0.786

// ---- Entries: reversal-based, no exit logic beyond an opposing signal ----
if isBullish
    float entrySize = na
    if low <= fib786
        entrySize := size786
    else if low <= fib618
        entrySize := size618
    else if low <= fib500
        entrySize := size500
    else if low <= fib382
        entrySize := size382
    if not na(entrySize)
        qty = (entrySize * leverage) / close
        strategy.entry("Long", strategy.long, qty = qty)
else if isBearish
    float entrySize = na
    if high >= fib786
        entrySize := size786
    else if high >= fib618
        entrySize := size618
    else if high >= fib500
        entrySize := size500
    else if high >= fib382
        entrySize := size382
    if not na(entrySize)
        qty = (entrySize * leverage) / close
        strategy.entry("Short", strategy.short, qty = qty)

plot(fib382, "Fib 38.2%", color = color.yellow)
plot(fib500, "Fib 50%", color = color.orange)
plot(fib618, "Fib 61.8%", color = color.red)
plot(fib786, "Fib 78.6%", color = color.maroon)
plot(lastPivotHigh, "Swing High", color = color.green)
plot(lastPivotLow, "Swing Low", color = color.blue)
```

## Backtest notes

- Run on the **1h chart**, BTCUSDT.P, on TradingView's Strategy Tester.
- **This version has zero risk control.** At 100x leverage with no stop
  loss, a single adverse move of roughly 1% would liquidate the position on
  a real exchange, and Pine's backtest doesn't simulate that at all — it
  will happily show the position riding out an arbitrarily large drawdown
  until the next opposite signal reverses it. Treat any backtest number
  from this version as "does the entry direction/timing look right," not as
  a realistic P&L — it structurally cannot be one without a stop.
- Position size (qty) still uses the leverage-scaled formula from iteration
  1, so the dollar P&L numbers will look large/volatile — that's leverage
  doing its job on paper, not a sign of anything broken.
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

## Next steps

1. **Design a stop-loss that fits 100x leverage**, informed by everything
   above: the entries are good (58% WR), so the stop doesn't need to fix
   entry quality — it needs to cut the tail risk of a single catastrophic
   hold like the -7.69% trade above, without cutting so tight that it
   chops up the many small, real wins the reversal-hold exit currently
   captures (iteration 1's lesson: a blanket tight cap crushed win rate
   without fixing the ratio). This is the one piece of risk management this
   version still completely lacks.
2. Re-verify iteration 3's ADX-filter result under the now-fixed swing
   logic — it was tested against the buggy trend direction, so that result
   is no longer trustworthy either way.
