---
name: create-strategy
description: Documents a new trading strategy for this project (trade-bot) by interviewing the user about entry logic, stop loss logic, take profit logic, exit rules, position sizing, and targets, then writes a strategies/<slug>.md file with a working TradingView Pine Script v6 backtest. Use this whenever the user asks to create, add, document, or design a new trading strategy, wants to prototype a strategy idea for backtesting, or mentions adding a strategy to the strategies/ folder. Make sure to use this rather than freehanding a one-off Pine script whenever the request is about a repeatable strategy concept, not a throwaway snippet.
---

# Create Strategy

Interviews the user, then writes `strategies/<slug>.md` — see
`strategies/README.md` for the file format and `strategies/ma-cross-demo.md`
for a filled-in example. This skill exists so every documented strategy goes
through the same rigor and produces the same shape of file, rather than
whatever level of detail comes out of an ad hoc conversation.

## Why an interview, not a template fill-in

A trading strategy is underspecified until someone has actually answered
what happens on a stop-out, what happens if price gaps past a limit, and how
big a position gets — skipping straight to Pine code papers over exactly the
decisions that determine whether the strategy is coherent at all. Ask one
focused question at a time, in the order below; don't dump the whole list
at once, and don't move on until an answer is actually usable (a vague
answer like "reasonable stop loss" needs a follow-up — reasonable how,
relative to what).

## Interview, one question at a time

1. **Name and thesis.** What's the strategy called, and what's the core
   idea/edge it's trying to capture?
2. **Market and timeframe.** Which symbol(s) and candle interval is this
   designed for?
3. **Entry logic.** Exact long entry condition. Ask separately whether short
   entries exist at all — don't assume a strategy is bidirectional.
4. **Stop loss logic.** Fixed percentage, ATR-multiple, structural
   (swing high/low), or genuinely none? If none, say so plainly in the
   output rather than omitting the section — see `ma-cross-demo.md` for how
   to document an intentional gap honestly.
5. **Take profit logic.** Fixed R-multiple, fixed percentage, trailing,
   indicator-based, or none?
6. **Exit rules beyond stop/target.** Signal reversal, time-based exit,
   trailing-stop adjustment, or anything else that closes a position.
7. **Position sizing.** Fixed percent of equity, fixed risk-per-trade
   (position size derived from stop distance), fixed contract count, or
   something else. Ask about leverage if this is a futures strategy.
8. **Targets.** Two distinct things — ask both: (a) is there a specific
   market regime or condition this is meant to work in (trending, ranging,
   high volatility), and (b) any performance expectation worth recording
   (target win rate, risk:reward, acceptable drawdown) — "none yet, this is
   exploratory" is a completely fine answer to either.
9. **Parameters.** List the concrete indicator settings and defaults (period
   lengths, multipliers, thresholds) — this becomes the Parameters table and
   the Pine script's `input.*` calls.

Ask follow-ups whenever an answer would change what code gets written.
Never invent a rule the user didn't specify — an unspecified aspect (e.g. no
stop loss) gets documented as absent, not filled in with a guess at what
might be reasonable.

## Writing the Pine Script v6

Write real, syntactically correct Pine v6 — this gets pasted directly into
TradingView's Pine Editor, so it has to actually compile. Pine v6 changed
enough from v5 that training-data intuition about Pine syntax is often
stale; the specifics below are worth checking every time, not just once:

- `//@version=6` as the first line, always.
- Every built-in function needs its namespace — `ta.sma()`, `ta.ema()`,
  `ta.crossover()`, `ta.crossunder()`, `ta.atr()`, `math.max()`, etc. Bare
  `sma()`/`ema()` is v4/v5 syntax and will not compile under v6.
- Inputs are typed: `input.int()`, `input.float()`, `input.string()`,
  `input.bool()` — not a bare `input()`.
- `strategy()`'s `margin_long`/`margin_short` **default to 100 in v6**,
  meaning no leverage. If the interview established leverage (e.g. 3x), set
  both explicitly to `100 / leverage` (3x → `33.33`) — otherwise the Pine
  backtest silently runs unleveraged regardless of what was described.
- `strategy.entry(id, direction, ...)` and `strategy.exit(id, from_entry=,
  stop=, limit=, ...)` — the `from_entry` value must exactly match the
  `id` used in the corresponding `strategy.entry()` call. A mismatch is a
  silent bug: the exit simply never fires, with no error. Double-check this
  every time stop/take-profit logic is present.
- If the strategy has no stop loss/take profit (an explicit "none" from the
  interview), don't call `strategy.exit()` at all — rely on
  `strategy.entry()`'s own reversal behavior (calling it for the opposite
  direction while a position is open closes the existing one and opens the
  new one) if the strategy flips on signal, or `strategy.close()` if it
  should just go flat.
- Set `process_orders_on_close=true` when the interview's entry/exit logic
  is candle-close-based (the common case, and what the engine itself does —
  see `apps/engine/src/marketData/binanceKlineStream.ts`) rather than
  intrabar.
- Default `commission_value` to `0.1` (percent) unless told otherwise —
  matches `PaperBroker`'s fee assumption in `apps/engine`, keeping the Pine
  backtest and any later paper-engine run comparable.
- Add `plot()` calls for the key indicator lines so the chart is actually
  readable, not just the strategy markers.

## Writing the file

Use the exact section order from `strategies/README.md`: Overview, Entry
logic, Stop loss logic, Take profit logic, Exit rules, Position sizing,
Targets, Parameters, Pine Script v6, Backtest notes, Status. Look at
`strategies/ma-cross-demo.md` for tone and level of detail — direct,
specific, willing to say "none" or flag a real gap rather than padding
every section with content.

- Slug the filename from the strategy name (lowercase, hyphens,
  `strategies/<slug>.md`). Check `strategies/` first — if the slug already
  exists, stop and tell the user; point them at `update-strategy` instead of
  silently overwriting.
- Status starts as `draft` — it hasn't been through TradingView's Strategy
  Tester yet, regardless of how confident the logic looks.
- Backtest notes should mention any real limitation of the Pine
  implementation relative to what was described (e.g. if position sizing
  used a risk-based formula that Pine can only approximate).

## After writing

Show the user the file path and a short summary of what was documented.
Suggest they actually run it in TradingView's Strategy Tester before
treating the numbers as meaningful, and mention that promoting a strategy
into `apps/engine/src/strategy/` is a separate, deliberate step — this skill
only produces the documented/backtestable version.
