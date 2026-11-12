// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportState } from '../panels/ExportPanel'
import { useExportFlow } from './useExportFlow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}))
vi.mock('./exportJobController', () => ({
  createExportJobController: () => ({
    mount: async () => {},
    dispose: async () => {},
  }),
}))
vi.mock('./exportLog', () => ({
  createExportLogMirror: () => ({ begin: vi.fn(), observe: vi.fn() }),
}))

function translate(key: string, args?: Record<string, unknown>) {
  return args ? `${key}:${JSON.stringify(args)}` : key
}

const isFocused = vi.fn<() => Promise<boolean>>()
const send = vi.fn().mockResolvedValue(undefined)
const setProgressBar = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  isFocused.mockReset().mockResolvedValue(false)
  send.mockClear()
  setProgressBar.mockClear()
  // Keep the actual window and notification bridges: mocking getCurrentWindow
  // would hide the constant-true regression this test is intended to catch.
  vi.stubGlobal('api', { window: { isFocused, setProgressBar }, notification: { send } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const terminalStates = [
  {
    state: { kind: 'complete', payload: { outputPath: 'clip.mp4', durationUs: 1000 } },
    title: 'export.notify_done_title',
    body: 'export.notify_done_body:{"path":"clip.mp4"}',
  },
  {
    state: { kind: 'error', detail: 'Encoder failed' },
    title: 'export.notify_failed_title',
    body: 'export.notify_failed_body:{"detail":"Encoder failed"}',
  },
] as const satisfies readonly { state: ExportState; title: string; body: string }[]

function setup() {
  const deps: Parameters<typeof useExportFlow>[0] = {
    proxyStateRef: { current: new Map() },
    decodeProbeMemo: { current: new Map() },
  }
  return renderHook(() => useExportFlow(deps))
}

describe('export desktop notifications', () => {
  it.each(terminalStates)('notifies for $state.kind while unfocused', async ({ state, title, body }) => {
    const { result } = setup()
    await act(async () => { result.current.setExportState(state) })
    expect(send).toHaveBeenCalledExactlyOnceWith({ title, body })
  })

  it.each(terminalStates)('suppresses $state.kind while focused', async ({ state }) => {
    isFocused.mockResolvedValue(true)
    const { result } = setup()
    await act(async () => { result.current.setExportState(state) })
    expect(send).not.toHaveBeenCalled()
  })

  it('queries focus again for the next export', async () => {
    isFocused.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { result } = setup()
    await act(async () => { result.current.setExportState(terminalStates[0].state) })
    expect(send).not.toHaveBeenCalled()
    await act(async () => { result.current.setExportState(terminalStates[1].state) })
    expect(send).toHaveBeenCalledExactlyOnceWith({
      title: terminalStates[1].title, body: terminalStates[1].body,
    })
  })

  it('tolerates a failed focus query', async () => {
    isFocused.mockRejectedValue(new Error('Window closed'))
    const { result } = setup()
    await act(async () => { result.current.setExportState(terminalStates[0].state) })
    expect(result.current.exportState).toEqual(terminalStates[0].state)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('export taskbar progress', () => {
  // The bridge used to drop this on the floor (a no-op), so the taskbar never
  // showed an export. Through the real bridge to the native window API.
  it('reaches the window API for each lifecycle step and clears on completion', async () => {
    const { result } = setup()
    await act(async () => { result.current.setExportState({ kind: 'starting' } as ExportState) })
    expect(setProgressBar).toHaveBeenLastCalledWith({ status: 'indeterminate' })
    await act(async () => { result.current.setExportState({ kind: 'error', detail: 'Encoder failed' }) })
    expect(setProgressBar).toHaveBeenLastCalledWith({ status: 'error', progress: 100 })
    await act(async () => { result.current.setExportState(terminalStates[0].state) })
    expect(setProgressBar).toHaveBeenLastCalledWith({ status: 'none' })
  })
})
