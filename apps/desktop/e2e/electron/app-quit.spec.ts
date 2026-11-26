// e2e gate: closing the editor window ends the process — including after a Motif
// has been rendered, when the offscreen capture host is still a listed
// BrowserWindow and `window-all-closed` will never fire again (main/windows.ts →
// quitWithEditor). Both tests press the same `window:close` IPC the titlebar ✕
// invokes.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { invokeCmd, launchApp } from './helpers/driver'

/// One frame of the library's lower-third. The channel returns the PNG BYTES
/// (Uint8Array); the signature is checked in-page. A rejection comes back as its
/// message so the caller can tell a timeout from any other failure.
function captureLowerThird(page: Page): Promise<{ isPng: boolean } | { error: string }> {
  return page.evaluate(async () => {
    try {
      const bytes = (await (window as any).api.backend.invoke('motif_capture_frame', {
        motifId: 'lower-third--library',
        tSec: 0.5,
        propsJson: '{}',
        width: 320,
        height: 180,
        contentHash: '',
      })) as Uint8Array
      // By signature, not size: a default lower-third is mostly transparent and
      // compresses to well under a kilobyte.
      return { isPng: bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 }
    } catch (error) {
      return { error: String(error) }
    }
  })
}

interface CapturePhases {
  hostBuilds: number; failed: number; loadMs: number; readyMs: number; setupMs: number; renderMs: number; outputMs: number
}

/// Where the capture service's time went so far, phase by phase; a phase cut
/// short by its deadline is counted too.
async function capturePhases(page: Page): Promise<string> {
  const d = await invokeCmd<CapturePhases>(page, 'motif_capture_diagnostics')
  const ms = (v: number) => `${Math.round(v)} ms`
  return `${d.hostBuilds} host builds, ${d.failed} failed; load ${ms(d.loadMs)}, ready ${ms(d.readyMs)}, ` +
    `setup ${ms(d.setupMs)}, render ${ms(d.renderMs)}, output ${ms(d.outputMs)}`
}

/// Windows Electron itself counts — the offscreen capture host included.
function listedWindows(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

/// Press the titlebar ✕. The invoke never resolves (its own window dies mid-call),
/// so it is fired and forgotten rather than awaited.
function pressCloseButton(page: Page): void {
  void page
    .evaluate(() => void (window as unknown as { api: { window: { close(): Promise<void> } } }).api.window.close())
    .catch(() => {
      // "Target closed" — the window went away, which is the point.
    })
}

async function expectProcessExits(app: ElectronApplication, why: string): Promise<void> {
  const proc = app.process()
  await expect
    .poll(() => proc.exitCode, { timeout: 20_000, message: `the process never exited after ${why}` })
    .not.toBeNull()
}

test('closing the window quits the app after a Motif has been rendered', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    const beforeCapture = await listedWindows(app)

    // One frame of a builtin Motif is enough to build the offscreen host. The
    // renderer registered the clock-takeover runtime at boot (main.tsx).
    // No project is open, so the built-in renders from the library's host.
    //
    // The first frame on a cold runner can outlast the capture deadline. A
    // timeout is probation (docs/motifs.md, failure latching): one more attempt
    // on a rebuilt host, a second consecutive timeout latches the lane. This test
    // is about quitting, so it takes that one retry and no more; the deadline
    // itself is motif-capture-load.spec.ts's.
    let frame = await captureLowerThird(page)
    console.log(`[app-quit] capture 1: ${'error' in frame ? frame.error : 'ok'}; ${await capturePhases(page)}`)
    if ('error' in frame && frame.error.includes('[motif:timeout]')) {
      frame = await captureLowerThird(page)
      console.log(`[app-quit] capture 2: ${'error' in frame ? frame.error : 'ok'}; ${await capturePhases(page)}`)
    }
    expect('error' in frame ? frame.error : null, 'a frame of the lower-third').toBeNull()
    expect('isPng' in frame && frame.isPng, 'the frame is a PNG').toBe(true)

    // The root cause, asserted rather than assumed — the host is now one more
    // window in Electron's own count.
    expect(await listedWindows(app)).toBe(beforeCapture + 1)

    pressCloseButton(page)
    await expectProcessExits(app, 'the window closed with a Motif capture host open')
  } finally {
    await app.close().catch(() => {}) // may already have exited; the wrapper still reaps the temp dir
  }
})

// Control arm: no host, so this path always worked. If BOTH tests fail, suspect
// the launch/close plumbing rather than the quit gate.
test('closing the window quits the app when no Motif was ever rendered', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    expect(await listedWindows(app)).toBe(1)
    pressCloseButton(page)
    await expectProcessExits(app, 'the window closed with no Motif capture host')
  } finally {
    await app.close().catch(() => {}) // may already have exited
  }
})
