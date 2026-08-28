import { TEXT_NAME_MAX, textSnippet } from "../../shared/textSnippet";
import type { CompositionSummary, LayerSummary } from "../ipc";

/// 1-based creation order among the compositions with NO label, root excluded —
/// the `N` in a derived `Group N`.
///
/// Deriving the number here rather than storing one on the composition is the
/// same decision `trackName.ts` makes for `Track N`: a stored number would have
/// to be renumbered on every ungroup, and main holds no locale bundle, so a name
/// computed there would ship one language into every UI. Labelled compositions
/// are skipped rather than counted, so naming one does not renumber its
/// neighbours — a labelled Group has a name of its own, and the numbers are only
/// there to tell the unnamed ones apart.
///
/// The order is the summary's own key order, which is main's insertion order
/// (`buildProjectSummary` walks `Object.values(p.compositions)`), i.e. the order
/// the Groups were created in. It renumbers when an unlabelled Group is
/// ungrouped, exactly as a lane renumbers when a track is pruned.
export function groupOrdinals(
  compositions: Readonly<Record<string, Pick<CompositionSummary, "id" | "label">>>,
  rootId: string,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const id of Object.keys(compositions)) {
    if (id === rootId) continue;
    if (compositions[id]?.label?.trim()) continue;
    n += 1;
    out.set(id, n);
  }
  return out;
}

/// The one name a Group is shown under — the clip on the timeline, the
/// breadcrumb crumb, the inspector's Group section: its composition's label,
/// else the derived `Group N`.
///
/// `ordinals` comes from `groupOrdinals`; a composition missing from it (an
/// ordinal map built from an older summary) falls back to the bare kind name,
/// which is the same rung `layerDisplayName` ends on. Never a uuid.
export function groupDisplayName(
  compositionId: string,
  compositionLabel: string | null,
  ordinals: ReadonlyMap<string, number> | undefined,
  t: (key: string, values: Record<string, unknown>) => string,
): string {
  const own = compositionLabel?.trim();
  if (own) return own;
  const n = ordinals?.get(compositionId);
  if (n !== undefined) return t("timeline.group_derived_name", { n });
  return t("kinds.compositionref", { defaultValue: "Group" });
}

/// The one name a layer is shown under, anywhere it is named: its own label,
/// else the source file it came from — for a Group layer, the composition it
/// shows — else, for a Text layer, the words it actually renders, else its
/// translated kind.
///
/// The Text rung is there because `kinds.text` is the one kind name that adds
/// nothing: every surface that shows it also shows a Type glyph beside it, and
/// nothing in the app ever WRITES a Text layer's label (`applyAddLayer` stores
/// `label: null`, and an .srt import runs it per cue), so without this rung a
/// hundred imported captions all read "Text". The search palette already names
/// captions by content — search/buildEntries.ts takes the same view from the
/// other end — so this makes the timeline agree with the palette rather than
/// inventing a rule.
///
/// The Group rung is the media rung for a kind whose source is a composition:
/// `kinds.compositionref` alone would read "Group" on every Group clip in the
/// project, so the composition's name — stored or derived — stands where a
/// media file's name stands for a video clip. A Group layer's OWN label still
/// wins, exactly as a renamed video clip's does.
///
/// A blank label counts as absent — clearing the inline-rename field must leave
/// a clip named after its media, not nameless. Blank CONTENT is absent for the
/// same reason, so an empty Text layer still reaches its kind rather than
/// rendering a zero-width name. A uuid is NEVER a name: it tells the user
/// nothing and displaces the text that would. Call this instead of
/// `layer.label ?? layer.id`.
///
/// `t` is structurally typed rather than `TFunction` so callers can pass
/// `useTranslation().t` straight through (same pattern as playheadItems.ts's
/// `formatPlayheadDelta`).
export function layerDisplayName(
  layer: LayerSummary,
  t: (key: string, values: Record<string, unknown>) => string,
  /// `groupOrdinals` over the live summary, for the derived `Group N`. Omitted
  /// by the surfaces that name no Group layer (a refusal's clip name); a Group
  /// then reads as its bare kind rather than as the wrong number.
  groupOrdinals?: ReadonlyMap<string, number>,
): string {
  const own = layer.label?.trim();
  if (own) return own;
  const media =
    "media_label" in layer.params ? layer.params.media_label.trim() : "";
  if (media) return media;
  if (layer.params.kind === "CompositionRef") {
    return groupDisplayName(
      layer.params.composition_id,
      layer.params.composition_label,
      groupOrdinals,
      t,
    );
  }
  if (layer.params.kind === "Text") {
    const content = textSnippet(layer.params.content, TEXT_NAME_MAX);
    if (content) return content;
  }
  return t(`kinds.${layer.kind.toLowerCase()}`, { defaultValue: layer.kind });
}
