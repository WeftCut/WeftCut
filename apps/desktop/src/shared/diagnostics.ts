export interface DiagnosticIncident {
  id: string
  startedAt: string
  version: string
  reason: 'unclean-exit' | 'process-failure'
}

export interface DiagnosticSummary {
  available: boolean
  environment: string
  previousSession: DiagnosticIncident | null
}

export interface DiagnosticsApi {
  summary(): Promise<DiagnosticSummary>
  exportBundle(): Promise<string | null>
  dismissPrevious(): Promise<void>
  recordError(message: string): void
}
