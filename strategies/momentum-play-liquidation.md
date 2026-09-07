# Momentum Play - Liquidation

**Status:** draft, not yet run through TradingView's Strategy Tester.

## Overview

Single-symbol PEPEUSDT.P, **15x leverage**, 5m candles. Trades the
opposite thesis from its sibling strategy,
[`momentum-play-funding.md`](momentum-play-funding.md): rather than riding
crowding while it persists, this fades a sharp price spike (the shape a
liquidation cascade leaves behind — a fast move with a quick partial
retrace) on the theory that cascades overshoot and mean-revert. Kept as a
separate strategy/file/symbol/timeframe from the funding leg rather than
combined into one script, per an explicit request to keep the two
mechanisms independent rather than have them fight each other inside a
single strategy. Deliberately high-risk, on a meme coin, on a fast
timeframe — the name is literal.

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
against real PEPE tick data — see Next steps.

Only enters from flat, same as the funding leg.

## Stop loss logic

**1× ATR(14) on the 5m chart**, from entry. Tighter multiple than the
funding leg's 1.5× deliberately: a false-positive wick read on a fast,
noisy 5m PEPE chart needs to be cut quickly rather than given room to be
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
| Symbol | PEPEUSDT.P | |
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

- Run on the **5m chart**, PEPEUSDT.P, on TradingView's Strategy Tester.
- **Not yet compiled or run** — written using only Pine primitives already
  confirmed working elsewhere in this repo (`ta.atr`, `math.min`/`max`,
  `strategy.entry`/`exit`, the same bracket-order idiom
  `short-term-high-risk.md` uses), but this exact script hasn't itself
  been pasted into TradingView yet. Treat as believed-correct, not
  confirmed-correct.
- The 3×ATR wick-size threshold is a first guess, not calibrated against
  real PEPE tick data — the most important thing to tune once backtested.
- PEPE's price is denominated in very small decimals — worth confirming
  TradingView's Strategy Tester handles the quantity/precision sensibly
  before trusting the numbers, a known general risk with meme-coin
  backtests that hasn't specifically been checked here yet.

## Next steps

1. **Paste into TradingView and confirm it actually compiles** — not yet
   done for this exact script.
2. **Calibrate the 3×ATR wick threshold** against real PEPE history once
   backtested.
3. Once compiling cleanly, apply the same live-verification discipline
   this project's other strategies used before ever considering paper or
   live capital.
