import type { Project } from './model'
import { serializeProject } from './serialize'

/** Audio-export channels whose Rust fn takes the full project as a call argument;
 *  the TS actor (the sole state owner) serializes and forwards it. */
export const EXPORT_PROJECT_CHANNELS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform',
])

/** The channel that mixes, and therefore the one that needs the baked audio
 *  sources. The conform gate never does: it reports which RAW conforms are
 *  missing, and a bake reads one of those. */
const AUDIO_MIX_CHANNEL = 'export_project_audio_only'

/** What the baker contributes to an audio-only export. Structural so the
 *  forward does not depend on the baker module — `AudioFxBaker` satisfies it. */
export interface AudioFxSources {
  layerAudioSources(
    project: Project,
    window?: { start_us: number; end_us: number } | null,
  ): Record<string, string>
}

/** Inject the wire-shape project into the export-channel args. `serializeProject`
 *  (the canonical wire shape — identity except for link member sorting) is what
 *  the Rust core deserializes into an identical `Project`.
 *
 *  For the mix channel it also injects `layerAudioSources` — the baked
 *  effect-chain sibling each layer's audio must come from instead of its media's
 *  raw conform (ADR 0063). The baker only names layers whose DESIRED signature
 *  is the one on disk, so an absent entry means "no effects", never "not ready
 *  yet"; readiness is the export gate's business (`ensure_export_audio_fx`),
 *  and it refuses rather than falling back (spec Decision 9). Omitted entirely
 *  when nothing is baked, which keeps a project with no audio effects on
 *  byte-identical args. */
export function injectProjectArgs(
  args: Record<string, unknown>,
  snapshot: Project,
  channel?: string,
  audioFx?: AudioFxSources | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...args, project: serializeProject(snapshot) }
  if (channel !== AUDIO_MIX_CHANNEL || !audioFx) return merged
  const sources = audioFx.layerAudioSources(snapshot, exportWindow(args))
  if (Object.keys(sources).length > 0) merged.layerAudioSources = sources
  return merged
}

/** The export range, as the renderer sends it (`startUs`/`endUs`, either one
 *  null for "the whole project"). Both must be numbers or there is no window —
 *  a half-specified one is what Rust already treats as none. */
function exportWindow(args: Record<string, unknown>): { start_us: number; end_us: number } | null {
  const start = args['startUs']
  const end = args['endUs']
  if (typeof start !== 'number' || typeof end !== 'number') return null
  return { start_us: start, end_us: end }
}
