---
status: accepted
---

# Project-schema upgrades are a version-keyed chain, and conversions may live nowhere else

Date: 2026-08-17

## Context

A cut-over schema gate (refuse any `project.json` whose `schema_version` is not
the build's) makes every user project unopenable at the first post-release bump,
and a chain added afterwards cannot rescue files already written. The gate had
already cost something: because a bump would refuse the files a change needed
to fix, three shape conversions shipped as unconditional rewrites in
`parseProject`'s normalize pass. The on-disk shape drifted across three
generations while the version stood still, so a file's version no longer said
which rewrites it needed.

## Decision

- **Load runs a version-keyed chain.** `state/migrate.ts` owns
  `MIN_SCHEMA_VERSION` (1), an ordered `STEPS` table of `v_n → v_n+1`
  functions and the runner (`upgradeWire`). `persistence.ts` keeps exactly two
  refusals: a missing/non-numeric version and a version ahead of the build. An
  older file is the chain's input. There is no downgrade.
- **Normalize owns defaults and validity repairs only.** Both are idempotent
  statements about the current shape. Every conversion (field renamed, merged,
  split, retyped, enum variant retired) is a step with a version number.
  `normalizeScaleLinked` illustrates the line: an absent flag defaults to
  `false`, a `true` the tracks contradict is repaired, and the flag is never
  inferred from equal tracks.
- **A step imports nothing.** Steps work on the wire object
  (`Record<string, unknown>`), declare local types for the fields they touch and
  write frozen literals; `migrate.ts` imports no model type, constant or default.
  Facts a step cannot compute from the file (Motif/media dimensions, the frozen
  v3 interpolation evaluator in `migrationEvaluation.ts`) arrive through the
  host-supplied `MigrationContext`, which may not carry current defaults or
  serializers. Anything read from the live model would silently re-anchor a
  historical step.
- **The runner owns the stamp and the clone.** It writes `schema_version` after
  each step and clones the input once, so a throwing step leaves the original.
- **Upgrade is in memory; the original bytes are kept.** `project.json` is
  rewritten by the first autosave. Before the workspace swap, opening writes and
  verifies a byte-identical `project.pre-v{n}.json` beside it (identical bytes
  reuse it; different bytes get `project.pre-v{n}.{k}.json`). A failed backup
  refuses the open. Not in `Backups/`: those snapshots are post-write and gc'd
  to the 20 newest.
- **Rust holds no version constant.** `native/src/state/project.rs` keeps the
  field for deserialization only; it never gates on or writes it.
- **Completeness is a test.** `migrate.completeness.test.ts` asserts
  `MIN_SCHEMA_VERSION + STEPS.length === SCHEMA_VERSION`, one step per version
  in between, and a frozen fixture per version under `fixtures/projects/` that
  still upgrades and validates. `migrate.contract.test.ts` enforces the import
  ban by reading the source (the repo has no linter).

## Consequences

- A `SCHEMA_VERSION` bump costs a step and a frozen fixture in the same PR.
- Fixtures have no generator: regenerating one from today's model would test a
  step against its own output.
- Pre-v1 development projects do not open; they report the version.
