/** Application bundles normally omit project details. Export only diagnostic
 * timing fields here, never labels, paths, arbitrary metadata, or error text. */
export function importDiagnosticDetails(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const category = payload.category as { kind?: unknown } | null
  const details = payload.details as Record<string, unknown> | null
  if (category?.kind !== 'Import' || typeof payload.message !== 'string'
    || !payload.message.startsWith('Import timing: ') || !details || details.schema !== 1) return undefined
  return select(details, 0)
}
const numbers = new Set(['schema', 'queue_ms', 'work_ms', 'total_ms', 'elapsed_ms', 'since_editable_ms', 'size_bytes', 'duration_us',
  'background_active', 'background_limit', 'waiting', 'reserved_mib', 'work_mib', 'threads_active', 'cpu_threads',
  'width', 'height', 'fps_num', 'fps_den', 'sample_rate', 'channels'])
const strings = new Set(['import_id', 'media_id', 'stage', 'status', 'cache', 'engine', 'app_version', 'measurement', 'reason', 'kind', 'codec', 'pix_fmt'])
const booleans = new Set(['background_completed', 'playing', 'background_playback', 'memory_pressure'])
const objects = new Set(['video', 'audio', 'admission_at_enqueue'])
function select(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (strings.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_.:+-]{1,128}$/.test(value)) out[key] = value
    else if (booleans.has(key) && typeof value === 'boolean') out[key] = value
    else if (depth < 2 && objects.has(key) && value && typeof value === 'object' && !Array.isArray(value)) out[key] = select(value as Record<string, unknown>, depth + 1)
    else if (depth === 0 && key === 'stages' && Array.isArray(value)) out[key] = value.slice(0, 16)
      .filter(v => v && typeof v === 'object').map(v => select(v, 1))
    else if (key === 'milestones_ms' && value && typeof value === 'object') out[key] = Object.fromEntries(Object.entries(value)
      .filter(([name, ms]) => ['pool_observed', 'editable', 'first_frame_submitted', 'audio_prepared'].includes(name) && typeof ms === 'number' && Number.isFinite(ms)))
    else if (key === 'unsettled_stages' && Array.isArray(value)) out[key] = value.filter(v => typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)).slice(0, 16)
  }
  return out
}
