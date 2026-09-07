# Momentum Play - Liquidation

**Status:** draft, not yet run through TradingView's Strategy Tester.

## Overview

Single-symbol DOGEUSDT.P, **15x leverage**, 5m candles. Trades the
opposite thesis from its sibling strategy,
[`momentum-play-funding.md`](momentum-play-funding.md): rather than riding
crowding while it persists, this fades a sharp price spike (the shape a
liquidation cascade leaves behind — a fast move with a quick partial
retrace) on the theory that cascades overshoot and mean-revert. Kept as a
separate strategy/file/timeframe from the funding leg rather than
combined into one script, per an explicit request to keep the two
mechanisms independent rather than have them fight each other inside a
single strategy. Deliberately high-risk, on a fast timeframe — the name
is literal. Originally scoped to PEPEUSDT.P for symbol diversity from the
funding leg, but consolidated onto DOGEUSDT.P after PEPE's symbol
couldn't be reliably switched to in this session's automated browser
control (unrelated to the strategy itself, which never got that far) —
simplicity won out over the diversification goal.

## Entry logic

Bidirectional, on the 5m candle close:

- `lowerWick = min(open, close) - low`, `upperWick = high - max(open, close)`
- `atr5m = ta.atr(14)`
- **Long** (fading a downward liquidation spike): `lowerWick >= 3 × atr5m`
  **and** the candle closed back above the midpoint of that wick
  (`close > low + lowerWick × 0.5`) — the midpoint check confirms genuine
  rejection at the low, not the candle simply continuing to accept price
  down there.
- **Short**: exact mirror on `upperWick`.

The 3×ATR wick-size threshold is a starting default, not calibrated
against real DOGE tick data — see Next steps.

Only enters from flat, same as the funding leg.

## Stop loss logic

**1× ATR(14) on the 5m chart**, from entry. Tighter multiple than the
funding leg's 1.5× deliberately: a false-positive wick read on a fast,
noisy 5m chart needs to be cut quickly rather than given room to be
"maybe still right."

## Take profit logic

**Fixed 1.5R** (1.5× the ATR-stop distance). Kept simple rather than
indicator-based, unlike the funding leg — a fast reversion scalp on a 5m
chart doesn't call for the same "wait for the underlying condition to
cool" logic; the wick itself is the whole signal, and a clean R-multiple
target is the more natural fit once it fires.

## Exit rules

Nothing beyond the stop-loss and take-profit above — no time-based exit,
no reversal-on-opposite-signal exit. Both are implemented as a single
bracket order placed at entry (stop and limit together), not two separate
resting orders managed bar-by-bar like the funding leg's, since neither
level moves after entry.

## Position sizing

**Risk-based**, same formula and same numbers as the funding leg: margin
sized so the 1×ATR stop distance costs exactly **20% of current equity**
if hit, at **15x leverage**. Same plain flag applies here too — 20% risk
per trade is large, recorded as specified rather than second-guessed.

Notional exposure = margin × 15.

## Targets

- **Market regime**: implicitly suited to choppy/volatile conditions where
  liquidation cascades actually happen — not explicitly gated by a regime
  filter, though (no ADX/volatility gate was requested).
- **Performance expectation**: none set — exploratory.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Symbol | DOGEUSDT.P | |
| Candle interval | 5m | |
| Leverage | 15x | |
| Risk % of equity per trade | 20% | |
| ATR length | 14 | |
| Wick-size threshold | 3× ATR(14) | unverified starting guess — see Next steps |
| ATR stop multiple | 1× | |
| Take-profit | 1.5R | R = the ATR-stop distance |

## Pine Script v6

Runs on the **5m chart**. Single-symbol, single-timeframe — no
`request.security()` needed, unlike the funding leg. Entries evaluated on
bar close (`process_orders_on_close=true`, since the wick shape can only
be known once the 5m candle has actually closed); stop and take-profit are
placed together as one native bracket order via `strategy.exit()`, which
Pine fills intrabar against the high/low like real resting orders would.

```pinescript
//@version=6
strategy(
     "Momentum Play - Liquidation",
     overlay=true,
     default_qty_type=strategy.fixed,
     default_qty_value=0,
     initial_capital=1000,
     currency=currency.USDT,
     // Simulates 15x leverage (100/15). COMPILE-TIME CONSTANT — Pine does
     // not allow margin_long/margin_short to reference an input variable,
     // so this literal must be hand-edited if the leverage input's default
     // is ever changed.
     margin_long = 6.667,
     margin_short = 6.667,
     commission_type = strategy.commission.percent,
     commission_value = 0.1,
     process_orders_on_close = true)

// ---- Inputs ----
leverage    = input.float(15, "Leverage (see margin_long/short note above)", minval = 1, maxval = 20, step = 1)
riskPct     = input.float(20, "Risk % of equity per trade")
atrLen      = input.int(14, "ATR length")
wickAtrMult = input.float(3.0, "Wick-size threshold (× ATR, unverified starting guess)")
atrStopMult = input.float(1.0, "ATR stop multiple")
tpRMult     = input.float(1.5, "Take-profit (R multiple of stop distance)")

atrVal = ta.atr(atrLen)

lowerWick = math.min(open, close) - low
upperWick = high - math.max(open, close)

// Confirms rejection, not continued acceptance at the extreme: price
// closed back above/below the midpoint of the wick it just printed.
lowerWickMid = low + lowerWick * 0.5
upperWickMid = high - upperWick * 0.5

isBullish = lowerWick >= wickAtrMult * atrVal and close > lowerWickMid
isBearish = upperWick >= wickAtrMult * atrVal and close < upperWickMid

// ---- Risk-based position sizing (same formula as momentum-play-funding) ----
f_qty(stopDistPrice, entryClose) =>
    stopDistPct = stopDistPrice / entryClose
    riskAmount  = strategy.equity * riskPct / 100
    margin      = riskAmount / (leverage * stopDistPct)
    (margin * leverage) / entryClose

// ---- Entries — only from flat, bidirectional ----
// Stop + take-profit are a single bracket order placed right at entry,
// since neither level needs to move after the fact (unlike the funding
// leg's resting stop + separately-evaluated indicator exit).
if strategy.position_size == 0
    if isBullish
        stopDist  = atrStopMult * atrVal
        stopPrice = close - stopDist
        tpPrice   = close + stopDist * tpRMult
        strategy.entry("Long", strategy.long, qty = f_qty(stopDist, close))
        strategy.exit("Bracket-L", from_entry = "Long", stop = stopPrice, limit = tpPrice)
    else if isBearish
        stopDist  = atrStopMult * atrVal
        stopPrice = close + stopDist
        tpPrice   = close - stopDist * tpRMult
        strategy.entry("Short", strategy.short, qty = f_qty(stopDist, close))
        strategy.exit("Bracket-S", from_entry = "Short", stop = stopPrice, limit = tpPrice)

plot(lowerWick, "Lower wick", color = color.green, display = display.data_window)
plot(upperWick, "Upper wick", color = color.red, display = display.data_window)
plot(atrVal * wickAtrMult, "Wick threshold", color = color.gray)
```

## Backtest notes

- Run on the **5m chart**, DOGEUSDT.P, on TradingView's Strategy Tester.
- **Live-verified**: pasted directly into TradingView and compiled cleanly
  on the first try — the Pine syntax reuse (ATR, wick math, bracket-order
  `strategy.exit`) from already-proven scripts in this repo held up.

## Backtest results (first run, unfiltered)

| Metric | Value |
|---|---|
| Total PnL | +7.3% |
| Max drawdown | **53.86%** |
| Win rate | 24.00% (6/25) |
| Profit factor | 1.77 |

**The drawdown is the real story here, and it isn't a surprise** — it's
the exact risk flagged plainly in Position sizing before this ever ran:
20% equity risked per trade means roughly 4-5 consecutive stop-outs erases
most of the account, and a 53.86% drawdown is consistent with close to
that happening once in this run. PF 1.77 is genuinely good on its own,
but +7.3% total return against a 53.86% drawdown is a rough risk-adjusted
picture — you risked losing over half the account to end up up single
digits.

Implied payoff ratio from PF and win rate (PF = (WR×avgWin) /
((1-WR)×avgLoss)) works out to roughly **5.6:1** avg win vs. avg loss —
notably wider than the 1.5R take-profit target alone would suggest,
meaning either the ATR-based stop distance varies a lot trade-to-trade,
or something in the win/loss mix isn't fully explained by the R-multiple
alone. Worth understanding once real per-trade data is examined (see Next
steps) rather than left as an unexplained gap.

## Backtest results (30m chart, unofficial spot-check — n=3, not statistically meaningful)

The script is single-timeframe with no `request.security()`, so it runs
on whatever chart timeframe is loaded — this result came from loading the
chart on **30m** instead of the intended 5m (see the desktop-app history
note above), not a deliberate parameter re-tune for that timeframe.

| Metric | Value |
|---|---|
| Total PnL | +624.16 USDT (+62.42%) |
| Max drawdown | 124.51 USDT (9.83%) |
| Win rate | 66.67% (2/3) |
| Profit factor | 453.689 |

**Flagging this clearly rather than treating it as a finding**: 3 trades
is nowhere near enough to draw a conclusion from, and a profit factor of
453 is itself a symptom of that — it means the single loss was tiny
relative to the two wins, which is exactly the kind of number a handful
of trades can produce by chance. It says nothing about what a 30m version
of this strategy would do over dozens or hundreds of trades. It also
uses the 5m-tuned parameters (3×ATR wick threshold, 1×ATR stop, 1.5R
target) unchanged, not values calibrated for 30m's different noise
profile. Worth widening the test window to accumulate a real sample size
on 30m before drawing any conclusion — see Next steps.

## Cross-symbol spot-check (PENGUUSDT.P, 30m assumed — not explicitly reconfirmed)

Same unmodified script/parameters (5m-tuned: 3×ATR wick, 1×ATR stop, 1.5R
target, 20% risk, 15x leverage), tried on a different symbol to see if the
DOGE 30m result generalized.

| Metric | Value |
|---|---|
| Total PnL | -376 USDT (-37.6%) |
| Max drawdown | 658 USDT (51.31%) |
| Win rate | 16.67% (1/6) |
| Profit factor | 0.428 |

**This is the more informative result of the two 30m spot-checks.** A
losing profit factor (<1) on a different symbol, with the same
unmodified parameters, is consistent with the DOGE 2/3 result being
noise from an undersized sample rather than a real cross-symbol edge —
exactly the risk flagged when that result was first recorded. Parameters
tuned for 5m DOGE wick behavior have no reason to transfer to a
different coin's volatility profile on a different timeframe without
being recalibrated per-symbol, and this result is consistent with that.
Reinforces: don't treat the DOGE 30m number as a finding, and don't
generalize this strategy across symbols without per-symbol
recalibration and a real sample size.

## Next steps

1. **Before reading anything into the 30m result above: get a real
   sample size.** Widen the backtest's date range on the 30m chart (load
   more history) until there are at least a few dozen trades, then
   re-evaluate win rate/PF/drawdown on that larger sample — 3 trades
   can't distinguish a real edge from luck.
2. **Raise win rate without guessing blind (5m, the original target).** The user asked specifically
   to improve on 24% (6/25) win rate. Per this project's own track
   record — `btc-high-risk.md`'s iteration 9 (EMA/VWAP confluence, guessed
   without evidence) made things *much worse*, while every diagnostic-log-
   driven change in this project's history found a real, durable edge —
   the next step is adding temporary `log.info()` calls capturing
   per-trade context (wick-to-ATR ratio, close-back-into-wick %, hour of
   day UTC, volume vs. recent average) at entry, running it again, and
   comparing the 6 winners against the 19 losers directly before touching
   the entry logic. Not yet done — session's live TradingView control hit
   friction switching chart symbols; next attempt should either retry
   live or have the user run the diagnostic version and share the Pine
   Logs output.
3. **Calibrate the 3×ATR wick threshold** against real DOGE history once
   the diagnostic pass above identifies what's actually differentiating
   winners from losers — not a blind bump to 4×/5× ATR.
4. Given the 53.86% drawdown, **also worth testing a materially lower risk
   % per trade** (e.g. 5-10% instead of 20%) as an independent lever from
   the win-rate work above — PF 1.77 suggests the edge itself may not need
   20% risk to be worth trading.
5. Once both levers are explored, apply the same live-verification
   discipline this project's other strategies used before ever
   considering paper or live capital.
