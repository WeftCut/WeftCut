// The window's "Pre-bake now" choices. The timeline records a request here;
// `MotifFrameService` resolves it against its project and declares the result
// to main. Plain module state with no subscriptions of its own, so the
// requests outlive a preview remount and a DOM-less realm never listens.

import type { LayerSummary, ProjectSummary } from "../../ipc";

interface Intent {
  /** The workspace session the request resolved under. Null while the preview
   * that resolved it knows none yet: its first session adopts the intent. */
  generation: number | null;
  /** The Motif layers the request expanded to when it was first seen. */
  layers: Set<string>;
}

interface Promotion {
  layerId: string;
  generation: number | null;
  layers: string[];
}

/** Requests for layers no resolved project has shown yet. */
const requested = new Set<string>();
/** Resolved intents, keyed by the requested layer (a Motif or a Group). */
const intents = new Map<string, Intent>();
/** Resolved requests awaiting their one promoted submission, newest first. */
let promotions: Promotion[] = [];
/** Every layer id of the last resolved project, to tell a deleted layer from
 * one the project does not show yet. */
let seen = new Set<string>();
let explicit: Set<string> | null = null;
const listeners = new Set<() => void>();

/// Demand full content at the queue front for a Motif or a Group's Motifs.
/// Kept until a preview resolves it, however long that takes.
export function requestPrebake(layerId: string): void {
  requested.add(layerId);
  for (const l of [...listeners]) l();
}

/// Wake-up on a new request; the state itself is read through the functions
/// below. Returns an unsubscribe fn.
export function subscribePrebakeIntents(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/// Bring the intents up to `summary`: a layer seen before and absent now was
/// deleted, so its intent and pending promotion go (a Group's intent loses a
/// deleted Motif the same way); a request the project shows resolves to
/// `expand(layer)`, at that moment, under `generation`. Returns whether any
/// request resolved.
export function resolvePrebakeIntents(
  summary: ProjectSummary,
  generation: number | null,
  expand: (layer: LayerSummary) => Iterable<string>,
): boolean {
  const present = new Map<string, LayerSummary>();
  for (const c of Object.values(summary.compositions)) for (const t of c.tracks) for (const l of t.layers) present.set(l.id, l);
  const gone = (id: string) => seen.has(id) && !present.has(id);
  for (const id of requested) if (gone(id)) requested.delete(id);
  for (const [id, intent] of intents) {
    if (gone(id)) { intents.delete(id); continue; }
    for (const layer of intent.layers) if (gone(layer)) intent.layers.delete(layer);
  }
  promotions = promotions.filter(p => !gone(p.layerId)).map(p => ({ ...p, layers: p.layers.filter(l => !gone(l)) }));
  seen = new Set(present.keys());
  let resolved = false;
  for (const id of [...requested]) {
    const layer = present.get(id);
    if (!layer) continue;
    requested.delete(id);
    resolved = true;
    const layers = [...new Set(expand(layer))];
    const intent = intents.get(id);
    if (intent) { intent.generation = generation; for (const l of layers) intent.layers.add(l); }
    else intents.set(id, { generation, layers: new Set(layers) });
    promotions.unshift({ layerId: id, generation, layers });
  }
  explicit = null;
  return resolved;
}

/// A preview acknowledged `generation`. Intents resolved under another
/// session belong to it and go; the ones resolved before the preview knew a
/// session join this one.
export function bindPrebakeIntents(generation: number): void {
  for (const [id, intent] of intents) {
    if (intent.generation === null) intent.generation = generation;
    else if (intent.generation !== generation) intents.delete(id);
  }
  promotions = promotions
    .filter(p => p.generation === null || p.generation === generation)
    .map(p => ({ ...p, generation }));
  explicit = null;
}

/// The Motif layers demanded at full content.
export function explicitPrebakeLayers(): ReadonlySet<string> {
  explicit ??= new Set([...intents.values()].flatMap(i => [...i.layers]));
  return explicit;
}

/// The Motif layers of each request awaiting promotion, newest request first.
/// Consumed: a user action is one retry submission, so ordinary re-plans
/// cannot reset main's finite retry budget repeatedly.
export function takePrebakePromotions(): readonly (readonly string[])[] {
  const taken = promotions.map(p => p.layers);
  promotions = [];
  return taken;
}

/// Forget every request and intent: the window has no project.
export function clearPrebakeIntents(): void {
  requested.clear();
  intents.clear();
  promotions = [];
  seen = new Set();
  explicit = null;
}
