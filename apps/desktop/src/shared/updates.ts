export type UpdateStatus = {
  phase: 'disabled' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
}
