import { TEXT_NAME_MAX, textSnippet } from "../../shared/textSnippet";
import { segmentsForSpan } from "../describe/segmentsForSpan";
import { formatTimecode } from "../frames";
import type { DescSegment, LayerSummary, ProjectSummary } from "../ipc";
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

/// The cached prose of every source the index carries, by media id — the shape
/// `descriptionsStore` holds it in. A present `null` is "known to have none",
/// an absent key "nobody has read this yet"; both contribute no entries, which
/// is why this file never has to tell them apart.
export type DescriptionsInput = ReadonlyMap<
  string,
  readonly DescSegment[] | null
>;

const CAPTION_SNIPPET_MAX = 80;

/// Display budget for a description row's label. Unlike `CAPTION_SNIPPET_MAX`
/// this caps only what is SHOWN: model prose runs well past a subtitle line,
/// and the phrase someone half-remembers is as likely to sit in a sentence's
/// tail as its head, so the segment stays a haystack whole.
const DESCRIPTION_SNIPPET_MAX = 80;

function withPinyin(haystacks: string[]): string[] {
  const out = [...haystacks];
  for (const h of haystacks) {
    const p = pinyinHaystacks(h);
    if (p) out.push(p.full, p.initials);
  }
  return out;
}

/// One entry per described segment of the source this clip places, so a phrase
/// found in the prose lands on a clip that actually shows it.
///
/// A described source with NO placement contributes nothing. Every row here
/// answers Enter by selecting a clip and parking the playhead on it, and a
/// source sitting only in the pool has neither — the `media` entry is what
/// finds that one, by file name.
///
/// Placed twice, described once: the join runs per PLACEMENT, so the same
/// segment yields one row per clip that shows it, each with its own time.
function descriptionEntries(
  layer: LayerSummary,
  params: { media_id: string; src_in_us: number; src_out_us: number },
  clipLabel: string,
  compositionId: string,
  descriptions: DescriptionsInput,
  tc: (us: number) => string,
): SearchEntry[] {
  const segments = segmentsForSpan(
    descriptions.get(params.media_id) ?? null,
    params.src_in_us,
    params.src_out_us,
  );
  const out: SearchEntry[] = [];
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, " ").trim();
    // The prose IS the label, so a segment without any is a segment with
    // nothing to find — the view a caption takes of a blank Text layer.
    if (!text) continue;
    const label = textSnippet(text, DESCRIPTION_SNIPPET_MAX);
    // Source into timeline 1:1 with no speed factor: the mapping `shotRows`
    // and marker anchoring already use, and description is refused outright on
    // a re-timed clip (`describe/describeEligibility.ts`), so a second mapping
    // rule here would exist only for footage that has no prose to place.
    //
    // Floored at the clip's own start because a segment may STRADDLE the
    // window — `segmentsForSpan` keeps a straddler deliberately — and the
    // source before the window is on no timeline to seek to.
    const tStartUs =
      layer.t_start_us + Math.max(0, seg.t_start_us - params.src_in_us);
    const tags = seg.tags.map((tag) => tag.trim()).filter((tag) => tag !== "");
    const haystacks = withPinyin([label]);
    const detailFrom = haystacks.length;
    if (text !== label) haystacks.push(...withPinyin([text]));
    // Tags are haystacks beside the prose, not decoration: `describe_clip`
    // produces them precisely as short filterable keywords — subjects,
    // setting, camera motion, shot type.
    if (tags.length > 0) haystacks.push(...withPinyin(tags));
    // One line for everything the row does not otherwise show, so a hit on a
    // tag and a hit deep in the sentence each display the words that matched.
    const behind = [...(text === label ? [] : [text]), ...tags].join(" · ");
    out.push({
      key: `description:${layer.id}:${seg.t_start_us}`,
      type: "description",
      label,
      // The CLIP and not its track: the label is prose, so the row has to say
      // which clip it is about, and two clips of one source share a track as
      // readily as they share a name.
      context: `${clipLabel} · ${tc(tStartUs)}`,
      haystacks,
      ...(haystacks.length > detailFrom
        ? { detail: { text: behind, from: detailFrom } }
        : {}),
      payload: {
        type: "description",
        layerId: layer.id,
        tStartUs,
        compositionId,
      },
    });
  }
  return out;
}

/// `descriptions` defaults to empty because that is the ordinary state: a
/// project whose sources have never been described contributes no entries of
/// that type, and reading one is a cache probe the caller owns — no argument
/// this function receives can start a model run.
export function buildEntries(
  summary: ProjectSummary | null,
  commands: CommandInput[],
  locale: LocaleInput,
  descriptions: DescriptionsInput = new Map(),
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
        if (layer.params.kind === "VideoClip") {
          entries.push(
            ...descriptionEntries(
              layer,
              layer.params,
              clipLabel,
              comp.id,
              descriptions,
              tc,
            ),
          );
        }
      }
    }
  }

  for (const comp of compositions) for (const mk of comp.markers) {
    // A hibernating marker is anchored at source material its clip no longer
    // shows, so its `t_us` is frozen at wherever it last resolved and no
    // timeline holds that instant any more. Every other row here answers Enter
    // by moving you somewhere real; this one could only park the playhead on
    // content that has nothing to do with it, so it is not offered at all. The
    // marker Panel keeps them, which is where one is revived or discarded.
    if (mk.hibernating) continue;
    const note = mk.note.replace(/\s+/g, " ").trim();
    // A written note with no name is exactly the thing someone searches for, so
    // emptiness is judged over both fields — but the note only NAMES the marker
    // when there is no label, the same view a caption takes of its content.
    const label = mk.label.trim() || textSnippet(note, TEXT_NAME_MAX);
    if (!label) continue;
    // Which composition, because the palette lists markers from all of them at
    // once and a bare timecode leaves two of them indistinguishable. The root is
    // not a Group and is never named as one — it IS the timeline, so it takes
    // the Panel kind's own title, as it does on a timeline tab.
    const where =
      comp.id === summary.root_id
        ? locale.t("dock_workspace.panels.timeline", {})
        : groupDisplayName(comp.id, comp.label, ordinals, locale.t);
    const haystacks = withPinyin([label]);
    const detailFrom = haystacks.length;
    if (note && note !== label) haystacks.push(...withPinyin([note]));
    entries.push({
      key: `marker:${mk.id}`,
      type: "marker",
      label,
      context: `${where} · ${tc(mk.t_us)}`,
      haystacks,
      ...(haystacks.length > detailFrom
        ? { detail: { text: note, from: detailFrom } }
        : {}),
      payload: { type: "marker", markerId: mk.id, tUs: mk.t_us, compositionId: comp.id },
    });
  }

  return entries;
}
