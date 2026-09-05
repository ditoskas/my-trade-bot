---
name: update-strategy
description: Updates an existing documented strategy in strategies/*.md — changing its entry logic, stop loss, take profit, exit rules, position sizing, targets, or parameters — and keeps the Pine Script v6 backtest code consistent with the change. Use this whenever the user asks to modify, change, tweak, or improve an existing strategy that already has a file in strategies/, rather than creating a new one from scratch (use create-strategy for that instead).
---

# Update Strategy

Changes one existing `strategies/<slug>.md` file and keeps its prose and its
Pine Script in sync — the two drifting apart (a rule described in the
Markdown that the code doesn't actually implement, or vice versa) is the
main failure mode this skill exists to prevent.

## Finding the strategy

If the user names the strategy clearly, read `strategies/<slug>.md`
directly. If it's ambiguous or the file doesn't exist under the obvious
slug, list `strategies/*.md` and ask which one they mean rather than
guessing.

## Scoping the change

Ask what's actually changing — don't re-run the full `create-strategy`
interview from scratch. Read the existing file first so the question can be
specific: "Right now the stop loss is a fixed 2% — what should it become?"
rather than "what's the stop loss?" If the requested change has knock-on
effects on another section (e.g. changing position sizing from fixed-percent
to risk-based now requires a stop-loss distance to size against), point that
out and ask about the dependent section too rather than leaving the file
internally inconsistent.

## Applying the change

- Update the relevant Markdown section(s) to reflect the new rule.
- Update the Pine Script v6 code to match — not just the line that obviously
  changed, but anything downstream of it (e.g. a new stop loss means adding
  a `strategy.exit()` call with a matching `from_entry` id; changed position
  sizing means updating `default_qty_type`/`default_qty_value` or the
  leverage-driven `margin_long`/`margin_short` values). See
  `create-strategy`'s "Writing the Pine Script v6" section for the v6
  syntax specifics (namespaced functions, typed inputs, the
  `margin_long`/`margin_short` leverage gotcha, `from_entry` id matching) —
  the same rules apply here.
- If the change invalidates a previous backtest, move `Status` back to
  `draft` and say so explicitly — don't leave a stale `backtested` or
  `promoted` status on logic that hasn't actually been re-verified.
- If the strategy was `promoted` (already ported into
  `apps/engine/src/strategy/`), flag clearly that the engine code is now out
  of sync with this update and ask whether the user wants that ported too —
  don't silently touch engine code as a side effect of a documentation
  update.

## After writing

Show a concise diff-style summary of what changed (old rule → new rule) and
the file path. Remind the user to re-run the Strategy Tester before trusting
the updated numbers if the logic itself changed, not just cosmetic wording.
