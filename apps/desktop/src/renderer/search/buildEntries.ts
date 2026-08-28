import { formatTimecode } from "../frames";
import type { ProjectSummary } from "../ipc";
import { compositionRefCounts } from "../lib/compositionRefs";
import { groupDisplayName, groupOrdinals, layerDisplayName } from "../lib/layerName";
import { trackDisplayName } from "../lib/trackName";
import type { ActionId } from "../shortcuts/defs";
import { pinyinHaystacks } from "./pinyin";
import type { MediaUsage, SearchEntry } from "./types";

/// Command snapshot the index builder consumes — labels pre-resolved by
/// the caller (searchIndexStore) so this stays a pure function of its
/// arguments: the spec's Worker seam.
export interface CommandInput {
  id: string;
  /// Active-locale label.
  label: string;
  /// en-US label — extra haystack so English queries hit on zh-CN UI.
  enLabel: string;
  actionId?: ActionId;
}

/// The two translators an entry may need, resolved by the caller for the same
/// reason `CommandInput` pre-resolves its labels: this file must stay a pure
/// function of its arguments (the Worker seam), so it can't reach for `i18n`.
/// `tEn` exists so a kind name indexed on a zh-CN UI is still findable by its
/// English name — the `enLabel` rule applied to Layers.
export interface LocaleInput {
  t: (key: string, values: Record<string, unknown>) => string;
  tEn: (key: string, values: Record<string, unknown>) => string;
}

const CAPTION_SNIPPET_MAX = 80;

function withPinyin(haystacks: string[]): string[] {
  const out = [...haystacks];
  for (const h of haystacks) {
    const p = pinyinHaystacks(h);
    if (p) out.push(p.full, p.initials);
  }
  return out;
}

export function buildEntries(
  summary: ProjectSummary | null,
  commands: CommandInput[],
  locale: LocaleInput,
): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const c of commands) {
    entries.push({
      key: `command:${c.id}`,
      type: "command",
      label: c.label,
      context: "",
      haystacks: withPinyin(c.label === c.enLabel ? [c.label] : [c.label, c.enLabel]),
      payload: {
        type: "command",
        commandId: c.id,
        ...(c.actionId !== undefined ? { actionId: c.actionId } : {}),
      },
    });
  }
  if (!summary) return entries;

  // EVERY composition is indexed: a clip inside a Group is as findable as one
  // on the root, and activating it opens the Group first (navigation.ts). One
  // fps lattice for the whole project, so the root's rate formats every time.
  const compositions = Object.values(summary.compositions);
  // Derived here rather than taken from the project store: this function is the
  // Worker seam and must stay a pure function of its arguments, and the ordinals
  // are a pure function of the summary it already has.
  const ordinals = groupOrdinals(summary.compositions, summary.root_id);
  const root = summary.compositions[summary.root_id];
  const fpsNum = root?.fps_num ?? 30;
  const fpsDen = root?.fps_den ?? 1;
  const tc = (us: number) => formatTimecode(us, fpsNum, fpsDen);

  const usagesByMedia = new Map<string, MediaUsage[]>();
  for (const comp of compositions) {
    for (const track of comp.tracks) {
      const trackLabel = trackDisplayName(track, comp.tracks, locale.t);
      for (const layer of track.layers) {
        const p = layer.params as { media_id?: string };
        if (typeof p.media_id !== "string") continue;
        const list = usagesByMedia.get(p.media_id) ?? [];
        list.push({
          layerId: layer.id,
          trackId: track.id,
          trackLabel,
          tStartUs: layer.t_start_us,
        });
        usagesByMedia.set(p.media_id, list);
      }
    }
  }
  for (const list of usagesByMedia.values()) {
    list.sort((a, b) => a.tStartUs - b.tStartUs);
  }

  for (const m of summary.media) {
    entries.push({
      key: `media:${m.id}`,
      type: "media",
      label: m.label,
      context: m.kind,
      haystacks: withPinyin([m.label]),
      payload: {
        type: "media",
        mediaId: m.id,
        available: m.available,
        usages: usagesByMedia.get(m.id) ?? [],
      },
    });
  }

  // Every non-root composition is a result of its own: a Group is something you
  // reuse, so it has to be reachable by name whether or not a clip currently
  // shows it — an orphan is exactly the case with no clip to find. Derived here,
  // like the ordinals, because this function is the Worker seam.
  const refCounts = compositionRefCounts(summary.compositions);
  for (const comp of compositions) {
    if (comp.id === summary.root_id) continue;
    const refCount = refCounts.get(comp.id) ?? 0;
    // Same name the pool row and the Group clip show; only the derived
    // `Group N` is locale-dependent, which is what earns the en-US haystack.
    const label = groupDisplayName(comp.id, comp.label, ordinals, locale.t);
    const enLabel = groupDisplayName(comp.id, comp.label, ordinals, locale.tEn);
    entries.push({
      key: `group:${comp.id}`,
      type: "group",
      label,
      context: locale.t("media_pool.groups_refs", { count: refCount }),
      haystacks: withPinyin(label === enLabel ? [label] : [label, enLabel]),
      payload: { type: "group", compositionId: comp.id, refCount },
    });
  }

  for (const comp of compositions) for (const track of comp.tracks) {
    // Same name the header shows. A derived name is locale-dependent, so the
    // en-US pass earns a second haystack exactly as a clip's kind fallback does.
    const trackLabel = trackDisplayName(track, comp.tracks, locale.t);
    const enTrackLabel = trackDisplayName(track, comp.tracks, locale.tEn);
    const first = track.layers.reduce<{ id: string; t: number } | null>(
      (acc, l) => (acc === null || l.t_start_us < acc.t ? { id: l.id, t: l.t_start_us } : acc),
      null,
    );
    entries.push({
      key: `track:${track.id}`,
      type: "track",
      label: trackLabel,
      context: track.role ?? track.kind,
      haystacks: withPinyin(
        trackLabel === enTrackLabel ? [trackLabel] : [trackLabel, enTrackLabel],
      ),
      payload: { type: "track", trackId: track.id, firstLayerId: first?.id ?? null },
    });

    for (const layer of track.layers) {
      const context = `${trackLabel} · ${tc(layer.t_start_us)}`;
      if (layer.params.kind === "Text") {
        const snippet = layer.params.content.replace(/\s+/g, " ").trim().slice(0, CAPTION_SNIPPET_MAX);
        if (!snippet) continue;
        entries.push({
          key: `caption:${layer.id}`,
          type: "caption",
          label: snippet,
          context,
          haystacks: withPinyin([snippet]),
          payload: { type: "caption", layerId: layer.id, tStartUs: layer.t_start_us },
        });
      } else {
        // Same name the timeline block and the inspector show, so a hit reads as
        // the clip the user can see. Only the kind fallback is locale-dependent,
        // which is why the en-US pass can differ and earn a second haystack.
        const clipLabel = layerDisplayName(layer, locale.t, ordinals);
        const enClipLabel = layerDisplayName(layer, locale.tEn, ordinals);
        entries.push({
          key: `clip:${layer.id}`,
          type: "clip",
          label: clipLabel,
          context,
          haystacks: withPinyin(
            clipLabel === enClipLabel ? [clipLabel] : [clipLabel, enClipLabel],
          ),
          payload: { type: "clip", layerId: layer.id, tStartUs: layer.t_start_us },
        });
      }
    }
  }

  for (const comp of compositions) for (const mk of comp.markers) {
    if (!mk.label.trim()) continue;
    entries.push({
      key: `marker:${mk.id}`,
      type: "marker",
      label: mk.label,
      context: tc(mk.t_us),
      haystacks: withPinyin([mk.label]),
      payload: { type: "marker", markerId: mk.id, tUs: mk.t_us, compositionId: comp.id },
    });
  }

  return entries;
}
