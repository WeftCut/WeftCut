import { create } from "zustand";
import { listCommands, subscribeCommandRegistry } from "../commands/registry";
import {
  syncDescriptions,
  useDescriptionsStore,
} from "../describe/descriptionsStore";
import i18n from "../i18n";
import type { ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { buildEntries, type CommandInput, type LocaleInput } from "./buildEntries";
import type { SearchEntry } from "./types";

/// IDE-style background index (spec §Index): dirty signals (summary
/// change via projectStore, locale change, command-registry change, a
/// description read landing) → debounce → async FULL rebuild from the
/// canonical snapshot → atomic swap. Queries always read the last
/// completed build — never a half-built one. Full rebuild (not
/// incremental diff) makes ghost entries impossible by construction;
/// pinyinHaystacks' content memo makes rebuilds cheap. buildEntries is
/// pure — the Worker escalation seam if project sizes ever demand it.
interface State {
  entries: SearchEntry[];
  version: number;
}

export const useSearchIndexStore = create<State>(() => ({
  entries: [],
  version: 0,
}));

export const useSearchEntries = (): SearchEntry[] =>
  useSearchIndexStore((s) => s.entries);

const DEBOUNCE_MS = 300;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildSliceTimer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

function commandInputs(): CommandInput[] {
  const tEn = i18n.getFixedT("en-US");
  return listCommands().map((c) => ({
    id: c.id,
    label: i18n.t(c.labelKey),
    enLabel: tEn(c.labelKey),
    // Spread only when set — CommandInput.actionId is `?: ActionId` (no
    // explicit `| undefined`), and exactOptionalPropertyTypes rejects an
    // object literal that assigns `undefined` to it directly.
    ...(c.actionId !== undefined ? { actionId: c.actionId } : {}),
  }));
}

/// Read fresh per rebuild, never cached: `languageChanged` marks the index dirty
/// (see wireSearchIndex), so the next build must see the NEW active locale.
function localeInput(): LocaleInput {
  const tEn = i18n.getFixedT("en-US");
  return {
    t: (key, values) => i18n.t(key, values),
    tEn: (key, values) => tEn(key, values),
  };
}

/// Every video source of a summary paired with the file it points at now —
/// what `syncDescriptions` needs to decide what to read and what to forget.
///
/// `Video` and nothing else: `describe_clip` reads a picture stream and refuses
/// every other kind, so an audio or image source has no cache worth probing.
function videoSources(summary: ProjectSummary | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of summary?.media ?? []) {
    if (m.kind === "Video") out.set(m.id, m.path);
  }
  return out;
}

function rebuildNow(): void {
  const summary = useProjectStore.getState().summary;
  const entries = buildEntries(
    summary,
    commandInputs(),
    localeInput(),
    // Read, never requested: a rebuild indexes whatever prose the store has
    // already been handed. Opening the palette starts no read at all, let
    // alone a model run.
    useDescriptionsStore.getState().segments,
  );
  useSearchIndexStore.setState((s) => ({ entries, version: s.version + 1 }));
}

export function markSearchIndexDirty(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Extra async slice keeps the rebuild off the dirty signal's own
    // stack — project:changed subscribers must stay cheap. Tracked so
    // teardown can cancel a scheduled-but-unfired rebuild too.
    if (rebuildSliceTimer !== null) clearTimeout(rebuildSliceTimer);
    rebuildSliceTimer = setTimeout(() => {
      rebuildSliceTimer = null;
      rebuildNow();
    }, 0);
  }, DEBOUNCE_MS);
}

/// One-shot wiring, called alongside wireProjectStore (useAppWiring).
/// Idempotent for HMR/StrictMode: a second call while wired only marks
/// dirty. Returns teardown.
export function wireSearchIndex(): () => void {
  if (wired) {
    markSearchIndexDirty();
    return () => {};
  }
  wired = true;
  const unsubProject = useProjectStore.subscribe((s, prev) => {
    if (s.summary === prev.summary) return;
    markSearchIndexDirty();
    // Off the POOL, not off the placements: a description is findable wherever
    // its source sits on a timeline, so the index wants every source that has
    // prose on disk — and the pool changes on an import, while the placements
    // change on every drag.
    void syncDescriptions(videoSources(s.summary));
  });
  const unsubRegistry = subscribeCommandRegistry(markSearchIndexDirty);
  // A read landing (or a relink dropping one) changes the corpus exactly as a
  // project edit does, and takes the same debounce.
  const unsubDescriptions = useDescriptionsStore.subscribe((s, prev) => {
    if (s.segments !== prev.segments) markSearchIndexDirty();
  });
  const onLocale = () => markSearchIndexDirty();
  i18n.on("languageChanged", onLocale);
  void syncDescriptions(videoSources(useProjectStore.getState().summary));
  rebuildNow();
  return () => {
    unsubProject();
    unsubRegistry();
    unsubDescriptions();
    i18n.off("languageChanged", onLocale);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (rebuildSliceTimer !== null) clearTimeout(rebuildSliceTimer);
    rebuildSliceTimer = null;
    wired = false;
  };
}
