# Video-understanding (description) facts

Findings behind the description pipeline that the code does not state.
Artifact pinning, the per-platform llama.cpp archives and the GPU-plus-CPU
superset rule are [ADR 0039](../adr/0039-local-engines-are-pinned-upstream-artifacts.md); pins live in `apps/desktop/src/shared/content-catalog.ts`.

## Local engine: Qwen3-VL-4B on llama-mtmd-cli (2026-08-30)

- Measured: ~20 s for 8 frames of Qwen3-VL-4B Q4_K_M on a Vulkan RTX 3050.
- **Q4_K_M model, F16 projector.** Q4_K_M is what the spike validated end to
  end (F16 is 8.0 GB, Q8_0 4.3 GB). The projector stays F16: it is small next
  to the model (797 MB vs 2.4 GB) and quantizing it is where vision quality
  goes.
- **Model and mmproj are separate catalog items.** A GGUF without its projector
  is text-only; `vlm::config::availability` reports `NeedsModel` for that state,
  so `vlmAutofillPlan` writes a config entry only with binary + model + mmproj.
- **Claim only complete engines.** `llama-mtmd-cli` also drives MiniCPM-V on
  the same frames + `<t s>` marker input, which is why
  `VlmConsumer.backends` is a list. It names `qwen3_vl` alone until the catalog
  carries MiniCPM model + projector entries; claiming the engine earlier makes
  its Settings row install a runtime and then report a set that cannot run.
- Hugging Face LFS object ids are SHA-256 by construction (checked byte for
  byte on the projector).

## Long clips: tidy and summary (2026-10-27)

Probe: a 10-minute documentary at 1 fps through Qwen3-VL-4B, chunked
(ADR 0147). Raw answer: 194 segments, 76 of them ≤ 1 s, runs of identical
lines (ten in a row, one per frame), and 70 one-second gaps (~11 % of the
timeline) because segment times are frame times. After `Run::tidied`
(gaps ≤ 2 s closed, zero-length stretched, touching near-duplicates merged by
character-bigram Dice ≥ 0.8, or ≥ 0.55 with tag Jaccard ≥ 0.75): 162 segments,
25 ≤ 1 s, no gaps.

- **Tidy is a read-time function of one run.** Stored segments stay as the
  model answered, so the rule can change with no migration. Never merge across
  runs: two shots that read alike are two answers.
- **Character bigrams, not words**, so unsegmented Chinese compares like English.
- **The summary request must carry frames.** Local `llama-mtmd-cli` has no
  one-shot text-only mode (without an image it opens an interactive chat).
  The summary is a second task on the same describer seam (up to 8 frames
  across the window + the tidied timeline as an outline capped at 3000
  characters), not a separate text model.
- **Only a JSON `summary` field counts.** Bare prose may be a preamble, a
  cut-off object or the outline read back; a wrong summary shown as the clip's
  is worse than none. A failed summary leaves the call answered without one.
- **Do not synthesize a lead from the first segments.** It read as a summary
  it was not; a run without a summary shows its details open instead.
- **On-screen text:** shown a title card, the model answered with the card's
  words alone, in their language. The prompt now says to quote on-screen text
  verbatim inside prose in the asked-for language. It is a prompt rule, not a
  check: whether a line is "in" a language is not decidable from its
  characters, so there is nothing to retry against.
