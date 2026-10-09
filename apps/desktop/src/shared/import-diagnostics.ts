/** Diagnostic events only; never persisted as project state. Durations use
 * monotonic clocks in their owning process, not cross-process timestamps. */
export const IMPORT_DIAGNOSTIC_EVENT = 'import:diagnostic'
export const IMPORT_DIAGNOSTIC_TRACK = 'import:diagnostic-track'
export const IMPORT_DIAGNOSTIC_MILESTONE = 'import_diagnostic_milestone'
export type ImportMilestone = 'pool_observed' | 'editable' | 'first_frame_submitted' | 'audio_prepared'
export const IMPORT_MILESTONES: readonly ImportMilestone[] = [
  'pool_observed', 'editable', 'first_frame_submitted', 'audio_prepared',
]
export interface ImportStageEvent {
  import_id?: string | null
  media_id?: string | null
  stage: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  queue_ms: number
  work_ms: number
  total_ms: number
  cache: 'miss' | 'hit' | 'shared'
  error?: string | null
  admission_at_enqueue?: Record<string, unknown>
}
