# Momentum Play - Funding

**Status:** draft, not yet run through TradingView's Strategy Tester.

## Overview

Single-symbol DOGEUSDT.P, **15x leverage**, 8h candles. Trades the theory
that when the perpetual futures price trades at an extreme premium or
discount to spot (the same dynamic that drives Binance's funding rate),
the crowding tends to continue a while longer (a squeeze) before it
unwinds — enters *with* the crowd, not against it. Deliberately high-risk,
paired with [`momentum-play-liquidation.md`](momentum-play-liquidation.md)
(the opposite thesis — fading a liquidation-cascade wick — kept as a
separate strategy/file/symbol/timeframe rather than combined, per an
explicit request to keep the two mechanisms independent) to diversify this
project's strategy mix away from the existing two, which are both
price-structure-based (`btc-high-risk.md`'s Fibonacci retracement,
`short-term-high-risk.md`'s trend-continuation breakout) — this one trades
an exchange-dynamic instead.

**Real funding-rate data is not usable here — confirmed live, not
assumed.** TradingView's Pine has no built-in funding-rate series, and even
the closest thing (the synthetic `BINANCE:DOGEUSDT.P_PREMIUM`
"derivative-metrics" instrument, which charts fine on its own) throws a
genuine runtime error ("cannot compile script" / "Failed to fetch") the
moment it's passed through `request.security()` — tested directly in the
Pine Editor before writing any of this script, specifically to avoid
shipping syntax that looks plausible but doesn't actually run. The fix used
instead: compute the **perp/spot basis** directly from two ordinary,
`request.security()`-friendly tradeable symbols (`BINANCE:DOGEUSDT.P` and
`BINANCE:DOGEUSDT`) — `(perp - spot) / spot`. This isn't a hack standing in
for the real thing; Binance's actual funding rate is mechanically derived
from this same sustained premium/basis, so "basis is extreme" is
functionally the same signal "funding is extreme" would give, just built
from data Pine can actually fetch.

## Entry logic

Bidirectional. On the 8h close:

- **Long**: `basisPct >= +0.5%` — perp trading at a premium to spot,
  crowd heavily long, betting the squeeze continues.
- **Short**: `basisPct <= -0.5%` — mirror, perp at a discount.

The ±0.5% threshold is a **starting guess, not calibrated against real
DOGE basis history** — flagged explicitly per the user's own call to
proceed without waiting to pull historical basis data first (see Next
steps). This is the first parameter worth tuning once backtested for real.

Only enters from flat — a signal while a position is already open is not
acted on (see Exit rules for why: exits are stop/take-profit only, not a
signal-reversal, so there's nothing for a same-bar opposite signal to do
except be ignored until the open position resolves on its own).

## Stop loss logic

**1.5× ATR(14) on the 8h chart**, from entry. Chosen over a
liquidation-tied stop (like `btc-high-risk`'s `1/leverage`) deliberately:
this strategy's real failure mode isn't "held through normal noise," it's
"the crowd unwinds violently and the extreme snaps back" — a genuine risk
with any crowding-continuation trade — which argues for a tighter,
self-calibrating stop rather than one that only caps at near-total
liquidation.

## Take profit logic

**Indicator-based**, not a fixed price/R-multiple: closes as soon as the
crowding that justified entry meaningfully cools, rather than waiting for
a full reversal. Concretely: exit the long once `basisPct` falls back
below `+0.25%` (half of the +0.5% entry threshold); exit the short once
`basisPct` rises back above `-0.25%`. Deliberately earlier than waiting
for a full sign flip through 0 — the thesis is "ride the squeeze while
crowding persists," and half-unwound crowding is already a weaker edge,
not something worth holding through to a full reversal.

## Exit rules

Nothing beyond the stop-loss and take-profit above — no time-based exit,
no separate reversal-on-opposite-signal exit.

## Position sizing

**Risk-based**: margin sized so the 1.5×ATR stop distance costs exactly
**20% of current equity** if hit — the same standard formula
`btc-high-risk.md`'s Backtest results section cites research for (`margin
= (equity × risk%) / (leverage × stopDistance%)`), generalized here since
this strategy's stop is ATR-based rather than a fixed liquidation
fraction. **20% risk per trade is a large number, flagged plainly**: at
that level, roughly 4-5 consecutive stop-outs would erase most of the
account. Recorded as specified rather than second-guessed — this is the
user's own deliberate choice for what's already an explicitly
high-risk strategy family, not a default that crept in unnoticed.

Notional exposure = margin × 15.

## Targets

- **Market regime**: none specified — untested against any particular
  regime.
- **Performance expectation**: none set — exploratory, per the interview.

## Parameters

| Name | Default | Notes |
|---|---|---|
| Symbol | DOGEUSDT.P | |
| Candle interval | 8h | matches Binance's funding settlement cadence |
| Leverage | 15x | |
| Risk % of equity per trade | 20% | |
| Basis entry threshold | ±0.5% | unverified starting guess — see Next steps |
| Basis exit threshold | ±0.25% | half of the entry threshold |
| ATR length | 14 | |
| ATR stop multiple | 1.5× | |
| Spot reference symbol | BINANCE:DOGEUSDT | for the perp/spot basis calc |

## Pine Script v6

Runs on the **8h chart**. Pulls the matching-resolution spot close via one
`request.security()` call (`lookahead=barmerge.lookahead_off`, the same
safe pattern the other two strategies in this repo use). Entries are
evaluated on bar close (`process_orders_on_close=true`, since both the
basis threshold and the exit condition are bar-close reads, not intrabar
touches) — the stop-loss is still a real resting order via
`strategy.exit()`, which Pine fills intrabar against the high/low like an
actual stop would.

```pinescript
//@version=6
strategy(
     "Momentum Play - Funding",
     overlay=false,
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
leverage      = input.float(15, "Leverage (see margin_long/short note above)", minval = 1, maxval = 20, step = 1)
riskPct       = input.float(20, "Risk % of equity per trade")
basisEntryPct = input.float(0.5, "Basis entry threshold (%, unverified starting guess)")
basisExitPct  = input.float(0.25, "Basis exit threshold (%)")
atrLen        = input.int(14, "ATR length")
atrStopMult   = input.float(1.5, "ATR stop multiple")
spotSymbol    = input.symbol("BINANCE:DOGEUSDT", "Spot symbol (for basis)")

// ---- Basis (perp/spot premium) — proxy for funding-rate extremity ----
// See Overview: real funding-rate history is not reachable via
// request.security() in Pine (confirmed live against the synthetic
// *_PREMIUM instrument, which errors even though it charts fine on its
// own). Binance's real funding rate is mechanically derived from this same
// sustained perp/spot premium, so this is a faithful proxy, not a
// stand-in guess.
spotClose = request.security(spotSymbol, timeframe.period, close, lookahead = barmerge.lookahead_off)
basisPct  = (close - spotClose) / spotClose * 100

atrVal = ta.atr(atrLen)

isBullish = basisPct >= basisEntryPct
isBearish = basisPct <= -basisEntryPct

// ---- Risk-based position sizing ----
// margin sized so the ATR-stop distance costs exactly riskPct% of current
// equity if hit: margin = (equity × risk%) / (leverage × stopDistance%) —
// see Position sizing above.
f_qty(stopDistPrice, entryClose) =>
    stopDistPct = stopDistPrice / entryClose
    riskAmount  = strategy.equity * riskPct / 100
    margin      = riskAmount / (leverage * stopDistPct)
    (margin * leverage) / entryClose

// ---- Position state ----
var float stopPrice = na

// ---- Entries — only from flat, bidirectional ----
if strategy.position_size == 0
    if isBullish
        stopDist = atrStopMult * atrVal
        strategy.entry("Long", strategy.long, qty = f_qty(stopDist, close))
        stopPrice := close - stopDist
    else if isBearish
        stopDist = atrStopMult * atrVal
        strategy.entry("Short", strategy.short, qty = f_qty(stopDist, close))
        stopPrice := close + stopDist

// ---- Exits: ATR stop (resting order) ----
if strategy.position_size > 0
    strategy.exit("SL-L", from_entry = "Long", stop = stopPrice)
else if strategy.position_size < 0
    strategy.exit("SL-S", from_entry = "Short", stop = stopPrice)

// ---- Exits: indicator-based take-profit (basis reverting) ----
if strategy.position_size > 0 and basisPct < basisExitPct
    strategy.close("Long", comment = "basis reverted")
else if strategy.position_size < 0 and basisPct > -basisExitPct
    strategy.close("Short", comment = "basis reverted")

plot(basisPct, "Basis %", color = color.blue)
hline(basisEntryPct, "Entry threshold (long)", color = color.green)
hline(-basisEntryPct, "Entry threshold (short)", color = color.red)
hline(basisExitPct, "Exit threshold (long)", color = color.gray)
hline(-basisExitPct, "Exit threshold (short)", color = color.gray)
hline(0, "Neutral", color = color.new(color.gray, 70))
```

## Backtest notes

- Run on the **8h chart**, DOGEUSDT.P, on TradingView's Strategy Tester.
- **Not yet compiled or run** — this session verified the `request.security`
  basis-calculation approach compiles and returns real values (tested live
  in the Pine Editor before writing this file), but the full strategy
  script above hasn't itself been pasted into TradingView yet. Treat it as
  believed-correct, not confirmed-correct, until that happens.
- The ±0.5%/±0.25% basis thresholds and the 1.5×ATR stop are all
  first-guess defaults, not calibrated against DOGE's real historical
  basis range — the single most important thing to tune once this is
  actually backtested.
- Risk-based sizing means dollar P&L scales with account size — expect
  early-run numbers to look different in scale as equity compounds,
  consistent with how `btc-high-risk.md` describes the same sizing model.

## Next steps

1. **Paste into TradingView and confirm it actually compiles** — this
   session verified the *mechanism* live, not this exact final script.
2. **Pull real DOGE basis history and calibrate the ±0.5%/±0.25%
   thresholds against it** — currently unverified guesses, flagged
   plainly rather than presented as tuned.
3. Once compiling cleanly, run the same live-verification/diagnostic-log
   discipline this project's other strategies used (see
   `btc-high-risk.md`'s iteration history) before ever considering this
   for paper or live capital.
