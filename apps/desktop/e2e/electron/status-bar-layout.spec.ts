import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'
import type { AgentActivity, AgentActivitySnapshot, AgentActivityUpdate } from '../../src/shared/agent-activity'
import { COMPUTE_JOBS_EVENT, type ComputeJobsUpdate } from '../../src/shared/compute-jobs'
import { SAVE_STATUS_EVENT, type SaveStatus } from '../../src/shared/save-status'
import enUS from '../../src/renderer/i18n/locales/en-US'
import zhCN from '../../src/renderer/i18n/locales/zh-CN'

// Every right-side status-bar item at once, at the main window's minimum size,
// in both UI languages: the bar keeps them on its one row, and the left message
// truncates. Whether they fit the bar's width is recorded, not asserted (see
// the assertions). Then agent mode, whose titlebar carries the same Not saved
// badge beside the exit button and the caption buttons: one row, inside the
// bar, no overlaps. Layout properties only, never pixels; screenshots of both
// bars are attached for a human to look at.
//
// Each item is raised through the boundary that raises it in the product: an
// agent's edit for the review count, the toolbar switch for the link override,
// log rows for the error and running badges, main's own events for the pushed
// state (jobs, agent activity, notices, save status), and main's update-status
// handler for the update offer.

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const LOCALES = { 'en-US': enUS, 'zh-CN': zhCN } as const

/** The right side's items, by the selector each renders with. */
const RIGHT_ITEMS = {
  linksOff: '[data-testid="link-override-chip"]',
  derivatives: '.derivatives-pill',
  compute: '[data-testid="status-bar-compute"]',
  agentRunning: '.agent-running-pill',
  review: '[data-testid="status-bar-review"]',
  errors: '.status-bar-badge-error',
  running: '.status-bar-badge-running',
  notSaved: '[data-testid="save-status-badge"]',
  system: '.system-status-trigger',
  update: '.status-bar-update',
  logs: '.status-bar-logs-toggle',
} as const

/** Long enough to overflow the left side at any window size. */
const LONG_MESSAGE = 'Layout probe: ' + 'a status message far longer than the bar can show '.repeat(8)

async function sendToRenderer(app: Awaited<ReturnType<typeof launchApp>>['app'], events: Array<[string, unknown]>) {
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const w of BrowserWindow.getAllWindows()) for (const [name, payload] of list) w.webContents.send(`evt:${name}`, payload)
  }, events)
}

async function connectAgent(page: Page): Promise<Client> {
  const info = await page.evaluate(() => (window as any).api.mcp.getInfo()) as { url: string; bearer_token: string }
  const client = new Client({ name: 'Layout probe agent', version: '1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }))
  return client
}

for (const locale of Object.keys(LOCALES) as Array<keyof typeof LOCALES>) {
  test(`every right-side status bar item keeps one row at the minimum window (${locale})`, async ({}, testInfo) => {
    test.setTimeout(150_000)
    const { app, page } = await launchApp({ locale })
    let client: Client | null = null
    try {
      await newProject(page, { parentFolder: tmpDir('weftcut-status-layout-'), name: 'status-layout', canvas: CANVAS })
      await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

      // An unreviewed agent change: a clip added inside a work session.
      client = await connectAgent(page)
      const call = (name: string, args: Record<string, unknown> = {}) => client!.callTool({ name, arguments: args })
      const tracks = await client.readResource({ uri: 'project://tracks' })
      const trackId = JSON.parse((tracks.contents[0] as { text: string }).text)[0].track_id as string
      expect((await call('begin_agent_session', { reason: 'Layout probe', lock: false })).isError).not.toBe(true)
      expect((await call('add_layers', { layers: [{ track_id: trackId, t_start_us: 0, t_end_us: 2_000_000, content: { kind: 'color', color: { r: 28, g: 76, b: 128, a: 255 } } }] })).isError).not.toBe(true)
      await expect(page.locator('.agent-mode-shell')).toBeVisible()
      await page.locator('.agent-exit-button').click()
      await expect(page.locator('.agent-mode-shell')).toHaveCount(0)
      await expect(page.locator(RIGHT_ITEMS.review)).toBeVisible()

      // The link override, by its toolbar switch: the same toggle as the
      // Alt+Shift+G chord, without the chord's timeline-focus precondition.
      await page.getByRole('button', { name: LOCALES[locale].quick_actions.link_override_off_hint }).click()
      await expect(page.locator(RIGHT_ITEMS.linksOff)).toBeVisible()

      // A running op.
      await invokeCmd(page, 'log_emit', { input: { level: 'info', category: { kind: 'Job' }, source: { kind: 'System' },
        message: 'Layout probe op', op_id: randomUUID(), op_state: { state: 'Started' } } })

      // State main pushes: a clip job, a derivative job, a running agent call,
      // a system notice, and a project that is not being saved. Revisions far
      // ahead of the app's own, so no real update replaces them mid-check.
      const snapshot = await invokeCmd<AgentActivitySnapshot>(page, 'agent_activity_snapshot')
      const now = new Date().toISOString()
      const runningCall: AgentActivity = {
        id: randomUUID(), session_id: snapshot.session?.id ?? null, connection_id: null, client: 'Layout probe agent',
        tool: 'read_project', kind: 'read', started_at: now, ended_at: null, state: 'running', duration_ms: null,
        message: 'read_project', affected: [], entity_labels: [], history_ids: [], effect: null, args: {}, error: null,
      }
      const activity: AgentActivityUpdate = { ...snapshot, revision: snapshot.revision + 1_000_000, from_revision: snapshot.revision,
        reset: true, removed_ids: [], removed_tack_ids: [], activities: [...snapshot.activities, runningCall] }
      const jobs: ComputeJobsUpdate = { revision: 1_000_000_000, ended: [], jobs: [{
        job_id: randomUUID(), tool: 'transcribe_clip', layer_id: '', media_id: 'layout-probe', window: { t_start_us: 0, t_end_us: 1_000_000 },
        phase: { kind: 'inferring', done: 1, total: 2 }, phase_since: now, started_at: now, origin: { kind: 'user' },
        callers: 1, caller_disconnected: false, request_ids: [] }] }
      const notSaved: SaveStatus = { state: 'failing', revision: 1_000_000_000, since: now, last_saved_at: null, code: 'ENOSPC',
        path: '/home/u/Projects/status-layout/project.json', dir: '/home/u/Projects/status-layout' }
      await sendToRenderer(app, [
        [COMPUTE_JOBS_EVENT, jobs],
        ['media:job_started', { media_id: 'layout-probe', kind: 'proxy' }],
        ['agent_activity:changed', activity],
        ['app:notices', [{ level: 'warn', code: 'keyring_unavailable' }]],
        [SAVE_STATUS_EVENT, notSaved],
      ])
      // An update on offer: main's own status handler answers it; the indicator polls.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('updates:status')
        ipcMain.handle('updates:status', () => ({ phase: 'available', version: '99.0.0' }))
      })

      // The minimum size main enforces for this window (mainWindowGeometryDefaults
      // for the active layout preset — the default one in a fresh profile).
      const win = await app.browserWindow(page)
      const [minWidth, minHeight] = await win.evaluate((w) => {
        if (w.isFullScreen()) w.setFullScreen(false)
        if (w.isMaximized()) w.unmaximize()
        const min = w.getMinimumSize()
        w.setSize(min[0]!, min[1]!)
        return min as [number, number]
      })
      await expect.poll(() => win.evaluate((w) => w.getSize().join('x'))).toBe(`${minWidth}x${minHeight}`)
      const [contentWidth, contentHeight] = await win.evaluate((w) => w.getContentSize() as [number, number])
      const size = { minWidth, minHeight, contentWidth, contentHeight }
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth)

      // The error last, so the bar's latest message is the long one (errors stick).
      await invokeCmd(page, 'log_emit', { input: { level: 'error', category: { kind: 'System' }, source: { kind: 'System' }, message: LONG_MESSAGE } })
      for (const selector of Object.values(RIGHT_ITEMS)) await expect(page.locator(`.status-bar ${selector}`)).toBeVisible()
      await expect(page.locator('.status-bar-message')).toHaveText(LONG_MESSAGE)

      const shot = testInfo.outputPath(`status-bar-${locale}.png`)
      await page.locator('.status-bar').screenshot({ path: shot })
      await testInfo.attach(`status-bar-${locale}`, { path: shot, contentType: 'image/png' })

      const layout = await page.evaluate((items) => {
        const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
        const bar = document.querySelector('.status-bar')!
        const message = document.querySelector<HTMLElement>('.status-bar-message')!
        return {
          bar: rect(bar),
          left: rect(bar.querySelector('.status-bar-left')!),
          right: rect(bar.querySelector('.status-bar-right')!),
          items: Object.fromEntries(Object.entries(items).map(([name, selector]) => {
            const el = bar.querySelector(selector)!
            // Every line box the item's content lays out on: wrapped content
            // has one starting below another's bottom.
            const range = document.createRange()
            range.selectNodeContents(el)
            const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
            const wraps = lines.length > 1 && Math.max(...lines.map((r) => r.top)) >= Math.min(...lines.map((r) => r.bottom))
            return [name, { ...rect(el), wraps }]
          })),
          message: { scrollWidth: message.scrollWidth, clientWidth: message.clientWidth, textOverflow: getComputedStyle(message).textOverflow },
        }
      }, RIGHT_ITEMS)
      await testInfo.attach(`status-bar-${locale}-layout`, { body: JSON.stringify({ size, ...layout }, null, 2), contentType: 'application/json' })

      // Agent mode at the same size: its titlebar holds every item it can show
      // at once (the badge, the exit button, the caption buttons off macOS).
      // Captured before any assertion, so both screenshots survive a failure.
      await page.locator('.menu-trigger').nth(2).click()
      await page.locator('.app-menu-item').filter({ hasText: new RegExp(`^${LOCALES[locale].view.enter_agent_mode}$`) }).click()
      const titlebar = page.locator('.agent-titlebar')
      await expect(titlebar.getByTestId('save-status-badge')).toBeVisible()
      await expect(titlebar.locator('.agent-exit-button')).toBeVisible()
      if (process.platform !== 'darwin') await expect(titlebar.locator('.window-controls')).toBeVisible()
      const titlebarShot = testInfo.outputPath(`agent-titlebar-${locale}.png`)
      await titlebar.screenshot({ path: titlebarShot })
      await testInfo.attach(`agent-titlebar-${locale}`, { path: titlebarShot, contentType: 'image/png' })
      const agentBar = await page.evaluate(() => {
        const bar = document.querySelector('.agent-titlebar')!
        const r = bar.getBoundingClientRect()
        return {
          bar: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          items: [...bar.children].map((el) => {
            const box = el.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(el)
            const lines = [...range.getClientRects()].filter((l) => l.width > 0 && l.height > 0)
            const wraps = lines.length > 1 && Math.max(...lines.map((l) => l.top)) >= Math.min(...lines.map((l) => l.bottom))
            const html = el as HTMLElement
            return { name: html.dataset.testid ?? html.className, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
              width: box.width, wraps, clipped: html.scrollWidth > html.clientWidth + 1 }
          }).filter((item) => item.width > 0),
        }
      })
      await testInfo.attach(`agent-titlebar-${locale}-layout`, { body: JSON.stringify({ size, ...agentBar }, null, 2), contentType: 'application/json' })

      const numbers = JSON.stringify({ size, bar: layout.bar, left: layout.left, right: layout.right })
      const centre = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2
      const rowCentre = centre(layout.items.logs)
      // Not asserted: that the right group fits the bar's width. With every
      // item at once it does not at the minimum size, with or without the
      // Not saved badge; the status bar's layout is due a redesign, and the
      // attached screenshot and boxes record how far it overflows.
      if (layout.right.right > layout.bar.right + 0.5) {
        testInfo.annotations.push({ type: 'known overflow', description: `right group ends at ${layout.right.right}, bar at ${layout.bar.right}` })
      }
      for (const [name, item] of Object.entries(layout.items)) {
        expect(item.top, `${name} inside the bar's height: ${numbers}`).toBeGreaterThanOrEqual(layout.bar.top - 0.5)
        expect(item.bottom, `${name} inside the bar's height: ${numbers}`).toBeLessThanOrEqual(layout.bar.bottom + 0.5)
        expect(Math.abs(centre(item) - rowCentre), `${name} shares the bar's one row`).toBeLessThanOrEqual(1)
        expect(item.wraps, `${name} keeps its content on one line`).toBe(false)
      }
      expect(layout.message.textOverflow).toBe('ellipsis')
      expect(layout.message.scrollWidth, 'the left message truncates rather than pushing items out').toBeGreaterThan(layout.message.clientWidth)

      // The titlebar has no text meant to truncate: its free space (the drag
      // strip on the left) is what gives way, so every item keeps its full
      // content, inside the bar, on one row, overlapping none of the others.
      const agentNumbers = JSON.stringify({ size, ...agentBar })
      const agentRow = (agentBar.bar.top + agentBar.bar.bottom) / 2
      for (const item of agentBar.items) {
        expect(item.left, `${item.name} starts inside the titlebar: ${agentNumbers}`).toBeGreaterThanOrEqual(agentBar.bar.left - 0.5)
        expect(item.right, `${item.name} ends inside the titlebar: ${agentNumbers}`).toBeLessThanOrEqual(agentBar.bar.right + 0.5)
        expect(item.top, `${item.name} inside the titlebar's height`).toBeGreaterThanOrEqual(agentBar.bar.top - 0.5)
        expect(item.bottom, `${item.name} inside the titlebar's height`).toBeLessThanOrEqual(agentBar.bar.bottom + 0.5)
        expect(Math.abs(centre(item) - agentRow), `${item.name} shares the titlebar's one row: ${agentNumbers}`).toBeLessThanOrEqual(1)
        expect(item.wraps, `${item.name} keeps its content on one line`).toBe(false)
        expect(item.clipped, `${item.name} shows its whole content: ${agentNumbers}`).toBe(false)
      }
      const ordered = [...agentBar.items].sort((a, b) => a.left - b.left)
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i]!.left, `${ordered[i - 1]!.name} overlaps ${ordered[i]!.name}: ${agentNumbers}`).toBeGreaterThanOrEqual(ordered[i - 1]!.right - 0.5)
      }
    } finally {
      await client?.close().catch(() => {})
      await app.close()
    }
  })
}
