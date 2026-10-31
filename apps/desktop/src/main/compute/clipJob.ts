import { createHash } from 'node:crypto'
import type { ComputeTool } from '../../shared/compute-jobs'
import type { Layer, MediaItem } from '../state/model'

/** What the registry needs to run one clip-compute call as a job: the args to
 *  forward (the slice and the engine hints already injected, no `job_id` yet),
 *  the singleflight key, and the job's identity for the record. */
export interface ClipJobSpec {
  tool: ComputeTool
  key: string
  args: Record<string, unknown>
  layer_id: string
  media_id: string
  window: { t_start_us: number; t_end_us: number }
}

/** What each arg a clip-compute call may carry is to its job (every advertised
 *  arg, plus those the host injects; `clipJob.test.ts` holds this to the MCP
 *  catalog, so a new arg cannot join jobs before it is classified here):
 *  - `answer`: changes the answer, so it is in the key. `speech_config` /
 *    `vlm_config` name the model an answer resolves to; they are hashed with
 *    the rest, never kept in the key.
 *  - `fresh`: asks for an answer computed by this call, not one an earlier
 *    call may have left. In the key too: a refresh never joins a plain run.
 *  - `span`: identity, read through the source below. */
type ArgRole = 'answer' | 'fresh' | 'span'
export const ARG_ROLES = {
  transcribe_clip: {
    backend: 'answer', preferred_backend: 'answer', language: 'answer', normalize_audio: 'answer',
    word_timestamps: 'answer', speech_config: 'answer',
    layer_id: 'span', t_start_us: 'span', t_end_us: 'span',
  },
  describe_clip: {
    backend: 'answer', preferred_backend: 'answer', language: 'answer', fps: 'answer', focus: 'answer',
    vlm_config: 'answer', purpose: 'answer', refresh: 'fresh',
    layer_id: 'span', src_start_us: 'span', src_end_us: 'span',
  },
} as const satisfies Record<ComputeTool, Record<string, ArgRole>>

/** An omitted arg keys as its default does, so leaving it out joins asking for it. */
const DEFAULTS: Partial<Record<string, unknown>> = { purpose: 'clip', refresh: false }

/** A layer's affine placement of its source, both ways, to the µs:
 *  `src = src_in_us + source_phase.in + (t − t_start_us) × rate`. */
function layerTiming(layer: Layer): { toSource: (t: number) => number; toTimeline: (src: number) => number } {
  const p = layer.params as unknown as { src_in_us?: number; time_map?: { rate: { num: number; den: number } }; source_phase?: { in: { num: number; den: number } } }
  const rate = p.time_map ? p.time_map.rate.num / p.time_map.rate.den : 1
  const origin = (p.src_in_us ?? 0) + (p.source_phase ? p.source_phase.in.num / p.source_phase.in.den : 0)
  return {
    toSource: (t) => Math.round(origin + (t - layer.t_start_us) * rate),
    toTimeline: (src) => Math.round(layer.t_start_us + (src - origin) / rate),
  }
}

/** A finished content hash. Anything else (`pending-…` while the import is
 *  hashing, a fixture's placeholder) is not an identity two items could share. */
const BLAKE3 = /^[0-9a-f]{64}$/

/** The job spec for one resolved call, or null when the slice did not resolve
 *  (no such layer, or one with no media) — Rust refuses those at once, so they
 *  run as plain calls rather than as jobs a retry could join.
 *
 *  The key is the tool, the source identity (the media's content hash; its id
 *  until hashed, so two placeholders never collide), the source span, and every
 *  answer-changing arg. The span is stated without mapping it: the window's
 *  offsets into the layer plus the
 *  layer's whole source mapping (`src_in_us`, time map, phases) name the same
 *  source samples whichever layer carries them, so a human press on a clip an
 *  agent is reading — or on a copy of that clip elsewhere — joins its job.
 *  `describe_clip`'s window is source time already, so it is the span itself;
 *  the record's timeline `window` is where the named layer plays it. */
export function clipJobSpec(tool: ComputeTool, args: Record<string, unknown>): ClipJobSpec | null {
  const layer = args.layer as Layer | null | undefined
  const media = args.media as MediaItem | null | undefined
  if (!layer || !media) return null
  const params = layer.params as unknown as Partial<Record<string, unknown>>
  const identity = BLAKE3.test(media.file_hash_blake3) ? `blake3:${media.file_hash_blake3}` : `media:${media.id}`
  const mapping = [params.src_in_us ?? null, params.time_map ?? null, params.source_phase ?? null, params.content_window ?? null]
  let tStart: number, tEnd: number, source: unknown[]
  if (tool === 'describe_clip') {
    const timing = layerTiming(layer)
    const srcStart = typeof args.src_start_us === 'number' ? args.src_start_us : null
    const srcEnd = typeof args.src_end_us === 'number' ? args.src_end_us : null
    tStart = srcStart === null ? layer.t_start_us : timing.toTimeline(srcStart)
    tEnd = srcEnd === null ? layer.t_end_us : timing.toTimeline(srcEnd)
    source = [identity, srcStart ?? timing.toSource(layer.t_start_us), srcEnd ?? timing.toSource(layer.t_end_us)]
  } else {
    tStart = typeof args.t_start_us === 'number' ? args.t_start_us : layer.t_start_us
    tEnd = typeof args.t_end_us === 'number' ? args.t_end_us : layer.t_end_us
    source = [identity, tStart - layer.t_start_us, tEnd - layer.t_start_us, ...mapping]
  }
  const answer = Object.entries(ARG_ROLES[tool]).filter(([, role]) => role !== 'span')
    .map(([k]) => [k, args[k] ?? DEFAULTS[k] ?? null])
  const key = createHash('sha256').update(JSON.stringify([tool, source, answer])).digest('hex')
  return { tool, key, args, layer_id: layer.id, media_id: media.id, window: { t_start_us: tStart, t_end_us: tEnd } }
}
