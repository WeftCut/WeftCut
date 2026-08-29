import { TEXT_NAME_MAX, textSnippet } from "../../shared/textSnippet";
import type { CompositionSummary, LayerSummary } from "../ipc";

/// The `N` in a derived `Group N`, per composition, root excluded — the stored
/// `Composition.ordinal` lifted into the map shape the naming chain takes.
///
/// The number is READ, never derived, and that is the whole point: it is state
/// the actor assigns once from a monotonic counter (model.ts `Composition`), so
/// naming one Group renumbers no other, clearing a label gives a Group its
/// original number back, and a deleted Group that undo brings back returns as
/// itself. A count computed over the live list could do none of those — every
/// one of them changes the list.
///
/// A LABELLED Group is in the map too — the number is independent of the name.
/// `groupDisplayName` prefers the label, so the number surfaces only when the
/// label is cleared, and then it is the Group's own.
///
/// Numbers therefore have gaps (delete Group 3 and the list reads 1, 2, 4) and
/// need not be in list order. Nothing may treat them as an index.
export function groupOrdinals(
  compositions: Readonly<Record<string, Pick<CompositionSummary, "id" | "ordinal">>>,
  rootId: string,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [id, composition] of Object.entries(compositions)) {
    if (id === rootId) continue;
    out.set(id, composition.ordinal);
  }
  return out;
}

/// The one name a Group is shown under — the clip on the timeline, its
/// timeline Panel's tab, the inspector's Group section: its composition's label,
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
