import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiagnosticIncident, DiagnosticSummary } from '../../shared/diagnostics'
import { AppDialog } from '../components/AppDialog'
import { Button } from '@/components/ui/button'
import { ISSUES_URL } from './links'

// Per reason: the notice's copy and what the prefilled issue asks the reporter.
const NOTICE = {
  'unclean-exit': {
    title: 'diagnostics.unclean_exit_title', body: 'diagnostics.unclean_exit_body',
    issueTitle: '[Bug] App did not close normally',
    question: 'How did it end: crashed, froze, force-quit, or shutdown / restart / power loss? / 上次是怎么结束的：崩溃、卡住、强制结束，还是关机 / 重启 / 断电？',
  },
  'process-failure': {
    title: 'diagnostics.process_failure_title', body: 'diagnostics.process_failure_body',
    issueTitle: '[Bug] A process failed',
    question: 'What were you doing when it happened? / 出错时你在做什么？',
  },
} as const satisfies Record<DiagnosticIncident['reason'], unknown>

export function diagnosticIssueUrl(summary: DiagnosticSummary): string {
  const previous = summary.previousSession
  // The repository disables blank issues. Address the existing form and its
  // field IDs instead of a body= URL that bypasses the template chooser.
  return `${ISSUES_URL}/new?${new URLSearchParams({
    template: 'bug_report.yml',
    title: previous ? NOTICE[previous.reason].issueTitle : '[Bug] ',
    version: summary.environment,
    ...(previous ? { what: `Previous session / 上次运行: ${previous.startedAt}, WeftCut ${previous.version}, ${previous.reason}\n\n${NOTICE[previous.reason].question}` } : {}),
    logs: '<!-- Review the exported ZIP, then drag it here to attach. This issue is public. / 检查导出的 ZIP 后拖到此处上传；此 issue 为公开内容。 -->',
  })}`
}

export function DiagnosticReport({ onClose, initialSummary }: {
  onClose: () => void
  initialSummary?: DiagnosticSummary
}) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<DiagnosticSummary | null>(initialSummary ?? null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (initialSummary) return
    let active = true
    void window.api.diagnostics.summary().then(s => { if (active) setSummary(s) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [initialSummary])

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(false)
    try { await action() } catch { setError(true) }
    finally { setBusy(false) }
  }
  const notice = summary?.previousSession ? NOTICE[summary.previousSession.reason] : null
  const close = () => {
    void run(async () => {
      if (summary?.previousSession) await window.api.diagnostics.dismissPrevious()
      onClose()
    })
  }
  return (
    <AppDialog title={t(notice ? notice.title : 'diagnostics.title')}
      onClose={busy ? undefined : close} panelClassName="settings-panel">
      <div className="settings-body">
        <div className="settings-card">
          {notice && <p className="settings-warn">{t(notice.body)}</p>}
          <p className="settings-blurb">{t('diagnostics.description')}</p>
          <p className="settings-blurb">{t('diagnostics.privacy')}</p>
          {summary && <p className="settings-blurb" style={{ overflowWrap: 'anywhere' }}>{summary.environment}</p>}
          {summary && !summary.available && <p role="status" className="settings-warn">{t('diagnostics.unavailable')}</p>}
          {saved && <p role="status" className="settings-blurb" style={{ overflowWrap: 'anywhere' }}>{t('diagnostics.saved', { path: saved })}</p>}
          {error && <p role="alert" className="settings-warn">{t('diagnostics.error')}</p>}
          <div className="export-actions" style={{ flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={busy || !summary?.available} onClick={() => void run(async () => {
              const file = await window.api.diagnostics.exportBundle()
              if (file) setSaved(file)
            })}>{t('diagnostics.export')}</Button>
            {saved && <Button variant="secondary" disabled={busy} onClick={() => void run(() => window.api.shell.reveal(saved))}>{t('diagnostics.reveal')}</Button>}
            <Button disabled={busy || !summary} onClick={() => void run(async () => {
              await window.api.shell.open(diagnosticIssueUrl(summary!))
              if (summary?.previousSession) await window.api.diagnostics.dismissPrevious()
            })}>{t('diagnostics.github')}</Button>
            <Button variant="ghost" disabled={busy} onClick={close}>{t('diagnostics.later')}</Button>
          </div>
        </div>
      </div>
    </AppDialog>
  )
}

/** Mounted once above the startup/editor route, after the splash. Merely
 * reading the notice does not acknowledge it (including React StrictMode). */
export function PreviousSessionReport() {
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null)
  useEffect(() => {
    let active = true
    void window.api.diagnostics.summary().then(s => {
      if (active && s.previousSession) setSummary(s)
    }).catch(() => { /* A failed diagnostics IPC cannot block opening a project. */ })
    return () => { active = false }
  }, [])
  return summary ? <DiagnosticReport initialSummary={summary} onClose={() => setSummary(null)} /> : null
}
