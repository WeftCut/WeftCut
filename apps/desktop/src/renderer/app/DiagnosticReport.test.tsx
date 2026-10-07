// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../i18n'
import { DiagnosticReport, PreviousSessionReport, diagnosticIssueUrl } from './DiagnosticReport'
import type { DiagnosticSummary } from '../../shared/diagnostics'

const summary: DiagnosticSummary = {
  available: true, environment: 'WeftCut 1.2.3 | linux x64',
  previousSession: { id: 'test', version: '1.2.2', startedAt: '2026-01-01T00:00:00Z', reason: 'unclean-exit' },
}
function stub(value = summary) {
  const api = {
    diagnostics: { summary: vi.fn().mockResolvedValue(value), dismissPrevious: vi.fn().mockResolvedValue(undefined),
      exportBundle: vi.fn().mockResolvedValue('/tmp/diagnostics.zip') },
    shell: { open: vi.fn().mockResolvedValue(undefined), reveal: vi.fn().mockResolvedValue(undefined) },
  }
  Object.assign(window, { api }); return api
}
afterEach(cleanup)

it('shows the previous-session notice under StrictMode without acknowledging on read', async () => {
  const api = stub()
  render(<React.StrictMode><PreviousSessionReport /></React.StrictMode>)
  expect(await screen.findByText('The previous session did not exit normally')).toBeTruthy()
  expect(api.diagnostics.dismissPrevious).not.toHaveBeenCalled()
  expect(api.shell.open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Not Now' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.diagnostics.dismissPrevious).toHaveBeenCalledOnce()
})

it('does not prompt after a clean session', async () => {
  const api = stub({ ...summary, previousSession: null })
  render(<PreviousSessionReport />)
  await waitFor(() => expect(api.diagnostics.summary).toHaveBeenCalled())
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('exports locally and explains manual attachment without uploading or opening GitHub', async () => {
  const api = stub()
  render(<DiagnosticReport initialSummary={summary} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export Diagnostic Bundle…' }))
  expect(await screen.findByText(/Saved to \/tmp\/diagnostics.zip/)).toBeTruthy()
  expect(api.shell.open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Show Exported File' }))
  await waitFor(() => expect(api.shell.reveal).toHaveBeenCalledWith('/tmp/diagnostics.zip'))
})

it('handles a cancelled save and a failed export, allowing retry', async () => {
  const api = stub(); api.diagnostics.exportBundle.mockResolvedValueOnce(null)
  render(<DiagnosticReport initialSummary={summary} onClose={() => {}} />)
  const button = screen.getByRole('button', { name: 'Export Diagnostic Bundle…' })
  fireEvent.click(button)
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  expect(screen.queryByText(/Saved to/)).toBeNull()
  api.diagnostics.exportBundle.mockRejectedValueOnce(new Error('disk full'))
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toBeTruthy()
  fireEvent.click(button)
  expect(await screen.findByText(/Saved to/)).toBeTruthy()
})

it('can report without diagnostic storage and only acknowledges after the browser opens successfully', async () => {
  const unavailable = { ...summary, available: false }
  const api = stub(unavailable)
  api.shell.open.mockRejectedValueOnce(new Error('browser unavailable'))
  render(<DiagnosticReport initialSummary={unavailable} onClose={() => {}} />)
  expect(screen.getByRole('button', { name: 'Export Diagnostic Bundle…' }).hasAttribute('disabled')).toBe(true)
  const button = screen.getByRole('button', { name: 'Open GitHub Issue' })
  fireEvent.click(button)
  await screen.findByRole('alert')
  expect(api.diagnostics.dismissPrevious).not.toHaveBeenCalled()
  fireEvent.click(button)
  await waitFor(() => expect(api.diagnostics.dismissPrevious).toHaveBeenCalledOnce())
})

it('prefills previous and current versions but never places attachments or local paths in the URL', () => {
  const url = new URL(diagnosticIssueUrl(summary))
  expect(url.origin + url.pathname).toBe('https://github.com/WeftCut/WeftCut/issues/new')
  expect(url.searchParams.get('template')).toBe('bug_report.yml')
  expect(url.searchParams.get('what')).toContain('WeftCut 1.2.2')
  expect(url.searchParams.get('version')).toContain('WeftCut 1.2.3')
  expect(url.searchParams.get('what')).toContain('unclean-exit')
  expect(url.href).not.toContain('/tmp/')
})
