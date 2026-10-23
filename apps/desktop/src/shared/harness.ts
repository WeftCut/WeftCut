// apps/desktop/src/shared/harness.ts
// The agent harness's closed vocabularies (ADR 0123): the stages a recipe may
// compose and the signals its exit condition may name. One source: the
// skill-conformance gate validates every shipped recipe against these lists
// and pins the shipped recipes/README.md to them, so a stage or signal exists
// here or nowhere.

/// Catalog order is the only order a recipe may list stages in — a recipe is
/// an ordered subset, never a reordering.
export const STAGES = ['intake', 'plan', 'build', 'audit', 'look', 'critique', 'handoff'] as const
export type Stage = (typeof STAGES)[number]

/// `rounds` is the one counter; the rest are facts that hold or do not.
export const SIGNALS = ['audit.clean', 'critique.clear', 'user.confirmed', 'rounds'] as const
export type Signal = (typeof SIGNALS)[number]

/// Build and its checks repeat at most this many rounds; what is left becomes
/// tacks and is reported.
export const MAX_ROUNDS = 3
