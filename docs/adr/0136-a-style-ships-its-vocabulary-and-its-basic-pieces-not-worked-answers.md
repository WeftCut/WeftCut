---
status: accepted
---

# A style ships its vocabulary and its basic pieces, not worked answers

Date: 2026-10-25

## Context

The clipping style shipped nine example Motifs (ADR 0130):
- **Five basic pieces:** a headline, a name stamp, a paper plate, a picture
  sticker, and a decoration scrap.
- **Three callouts:** a highlighted quote, a marker pointer, and a word torn
  out from under a cover.
- **One animation:** `clipping-network`, written for the memory talk
  (ADR 0134).

The bench showed agents reaching for them by default:
- **The network** was reused for unrelated processes.
- **The callouts** were placed as they came.
- **The style's worked scene** named the test talk's own content until it
  was cleaned (`becc227e`).

More styles are coming. A full set of components per style would make each
one heavy, and would steer models to the same answers.

## Decision

- **A style ships its vocabulary in words and tokens, plus the few pieces
  every edit needs.** For clipping that is four Motifs:
  - `clipping-headline` (title);
  - `clipping-stamp` (lower third);
  - `clipping-paper` (plate);
  - `clipping-sticker` (a picture pasted on).
- **Callouts, decoration and animations have no example.**
  - The style describes them in words.
  - The agent writes them in the vocabulary, from the shared props, the
    spring and the paper.
- **These Motifs are removed:**
  - `clipping-network`, which revises ADR 0134;
  - `clipping-quote`, `clipping-pointer` and `clipping-reveal`;
  - `clipping-scrap`.
- **The product's own templates stay.** These are `countdown`,
  `lower-third` and `text-fx`. They belong to no style.

## Consequences

- **Agents write more Motifs.**
  - A callout costs a draft instead of a placement.
  - How well it matches the style now depends more on the model.
  - The user's review covers what the audit's `token-drift` and the
    examples used to.
- **Fewer shared examples for agents to learn from.** The four that remain
  still carry the `clipping-common` helpers (the spring, the shadow, the
  torn edge) for a fork to start from.
- **A layer placed with a removed Motif no longer finds it.** Only bench
  projects hold such layers, because the clipping style has not shipped.
