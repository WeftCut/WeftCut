// apps/desktop/src/main/state/pauseSubject.ts
//
// Which Audio layer a pause operation reads and writes — the SUBJECT. One pure
// function over a project snapshot, shared by the two pause hybrids
// (`hybrids.ts`) and the MCP compute resolver (`clip-slice-forward.ts`); the
// renderer keeps its own twin over `LayerSummary` + the composition's links.
// Owns the subject rule and the one refusal sentence, nothing else: no
// detection, no writes, no defaults.
//
// See `.scratch/pauses/spec.md` Decision 1.
import type { Composition, Layer, Project } from './model'
import { eachLayer } from './model'

/** The subject and where its times live, or why there is none.
 *
 *  `delegatedFrom` is the layer the CALLER named when that layer is not the
 *  subject — a VideoClip that handed the question to its linked audio. Null
 *  when the named layer is its own subject, which is what lets a surface say
 *  "measured on the linked audio" only when it actually was. */
export type PauseSubjectResolution =
  | { ok: true; subject: Layer; composition: Composition; delegatedFrom: Layer | null }
  | { ok: false; reason: 'not_found' | 'plays_no_sound' }

/** Resolve the Audio layer a pause is a fact about.
 *
 *  Three steps, in order: an `Audio` layer is its own subject; a `VideoClip`
 *  delegates to the Audio member of its link that shares its media, else to the
 *  link's SOLE Audio member; anything else has no subject.
 *
 *  Only `LayerParams::Audio` reaches either mixer, so a VideoClip's embedded
 *  track is not what plays — reading the source file makes a muted, slipped or
 *  deleted partner invisible to the detector and cuts picture by sound nobody
 *  hears. Resolving on the Audio layer also makes A/V slip correct for free:
 *  its own `src_in_us` / `t_start_us` are the ones that map the ranges.
 *
 *  Same-media BEFORE sole-member, because a paired import is the common case
 *  and a second Audio member (music, a voiceover) must not win over the clip's
 *  own track. Two Audio members and neither shares the media is genuinely
 *  ambiguous, so it refuses rather than guessing. */
export function resolvePauseSubject(
  layerId: string,
  snapshot: Pick<Project, 'compositions'>,
): PauseSubjectResolution {
  const found = findLayerEntry(layerId, snapshot)
  if (!found) return { ok: false, reason: 'not_found' }
  const { layer, composition } = found
  if (layer.params.kind === 'Audio') return { ok: true, subject: layer, composition, delegatedFrom: null }
  if (layer.params.kind !== 'VideoClip') return { ok: false, reason: 'plays_no_sound' }

  // Link members are layers of ONE composition (validate enforces it), so the
  // partner search never leaves this composition's own layer set.
  const clipMedia = layer.params.media
  const link = composition.links.find((l) => l.members.includes(layer.id))
  if (!link) return { ok: false, reason: 'plays_no_sound' }
  const byId = new Map<string, Layer>()
  for (const track of composition.tracks) for (const l of track.layers) byId.set(l.id, l)
  const audio = link.members
    .map((id) => byId.get(id))
    .filter((l): l is Layer => l !== undefined && l.params.kind === 'Audio')
  const sameMedia = audio.find((l) => l.params.kind === 'Audio' && l.params.media === clipMedia)
  const subject = sameMedia ?? (audio.length === 1 ? audio[0] : undefined)
  return subject
    ? { ok: true, subject, composition, delegatedFrom: layer }
    : { ok: false, reason: 'plays_no_sound' }
}

/** The `plays no sound` refusal, minted once so every surface says the same
 *  sentence in its own verb: the two hybrids open with theirs, the MCP compute
 *  resolver with the tool name. Names the kind, because "this clip" is exactly
 *  the ambiguity a reader is stuck in — and names the remedy, because on a
 *  timeline the remedy is a click away. */
export function playsNoSoundError(
  verb: string,
  layerId: string,
  snapshot: Pick<Project, 'compositions'>,
): Error {
  const kind = findLayerEntry(layerId, snapshot)?.layer.params.kind ?? 'layer'
  return new Error(
    `${verb}: layer ${layerId} plays no sound — it is a ${kind} with no linked Audio layer; select the audio clip`,
  )
}

function findLayerEntry(
  layerId: string,
  snapshot: Pick<Project, 'compositions'>,
): { layer: Layer; composition: Composition } | null {
  for (const e of eachLayer(snapshot)) if (e.layer.id === layerId) return { layer: e.layer, composition: e.composition }
  return null
}
