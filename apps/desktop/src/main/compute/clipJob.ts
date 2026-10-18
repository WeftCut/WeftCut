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

/** The args that change a tool's ANSWER, beyond the source span. Everything
 *  else on the call (the layer id, the injected slice) is identity, read
 *  through the source below. `vlm_config` is in because it names the model a
 *  description resolves to; it is hashed with the rest, never kept. */
const ANSWER_ARGS: Record<ComputeTool, readonly string[]> = {
  transcribe_clip: ['backend', 'preferred_backend', 'language', 'normalize_audio', 'word_timestamps'],
  describe_clip: ['backend', 'preferred_backend', 'language', 'fps', 'focus', 'vlm_config'],
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
 *  agent is reading — or on a copy of that clip elsewhere — joins its job. */
export function clipJobSpec(tool: ComputeTool, args: Record<string, unknown>): ClipJobSpec | null {
  const layer = args.layer as Layer | null | undefined
  const media = args.media as MediaItem | null | undefined
  if (!layer || !media) return null
  const params = layer.params as unknown as Partial<Record<string, unknown>>
  const tStart = typeof args.t_start_us === 'number' ? args.t_start_us : layer.t_start_us
  const tEnd = typeof args.t_end_us === 'number' ? args.t_end_us : layer.t_end_us
  const source = [
    BLAKE3.test(media.file_hash_blake3) ? `blake3:${media.file_hash_blake3}` : `media:${media.id}`,
    tStart - layer.t_start_us, tEnd - layer.t_start_us,
    params.src_in_us ?? null, params.time_map ?? null, params.source_phase ?? null, params.content_window ?? null,
  ]
  const answer = ANSWER_ARGS[tool].map((k) => [k, args[k] ?? null])
  const key = createHash('sha256').update(JSON.stringify([tool, source, answer])).digest('hex')
  return { tool, key, args, layer_id: layer.id, media_id: media.id, window: { t_start_us: tStart, t_end_us: tEnd } }
}
