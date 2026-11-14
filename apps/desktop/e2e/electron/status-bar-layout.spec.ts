import { test, expect, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'
import type { AgentActivity, AgentActivitySnapshot, AgentActivityUpdate } from '../../src/shared/agent-activity'
import { COMPUTE_JOBS_EVENT, type ComputeJobsUpdate } from '../../src/shared/compute-jobs'
import { LAYOUT_THEME_IDS } from '../../src/shared/layout-theme'
import { SAVE_STATUS_EVENT, type SaveStatus } from '../../src/shared/save-status'
import enUS from '../../src/renderer/i18n/locales/en-US'
import zhCN from '../../src/renderer/i18n/locales/zh-CN'

// Every status-bar item at once, at each layout theme's minimum window size,
// in both UI languages: the log line on the left (with its unseen-error count)
// gives way and truncates, and the right group (the work pill, Save failed, the
// bell) keeps its one row inside the bar, each item whole, none overlapping.
// Each popover (work, Save failed, the bell's notification center), open, stays
// inside the window above the bar, and opening one closes the other. Then agent
// mode, whose titlebar carries the same Save failed pill and bell beside the exit
// button and the caption buttons: one row, inside the bar, no overlaps, and
// both popovers drop down inside the window. Layout properties only, never
// pixels; screenshots and boxes are attached for a human to look at.
//
// A theme's minimum is capped by the display's work area (layout-theme.spec.ts),
// so the large themes on a small runner display are the tightest case: the
// largest text in the narrowest window.
//
// Each item is raised through the boundary that raises it in the product: an
// agent's edit for the review row, a log row for the error count, main's own
// events for the pushed state (jobs, agent activity, notices, save status),
// and main's update-status handler for the update row.

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const LOCALES = { 'en-US': enUS, 'zh-CN': zhCN } as const

/** The right group's items, by the selector each renders with. */
const RIGHT_ITEMS = {
  work: '[data-testid="status-bar-work"]',
  saveFailed: '[data-testid="save-failed-pill"]',
  bell: '[data-testid="status-bar-bell"]',
} as const

/** Long enough to overflow the log line at any window size. */
const LONG_MESSAGE = 'Layout probe: ' + 'a status message far longer than the bar can show '.repeat(8)

/** The one notice raised here; at warn it is the most severe item the bell lists. */
const NOTICE = { level: 'warn', code: 'keyring_unavailable' } as const

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

interface PopoverBox {
  left: number; right: number; top: number; bottom: number
  viewWidth: number; viewHeight: number
  /** Content wider than the popover: a row that does not wrap is cut off. */
  overflowsX: boolean
}

function popoverBox(popover: Locator): Promise<PopoverBox> {
  return popover.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, viewWidth: window.innerWidth, viewHeight: window.innerHeight,
      overflowsX: el.scrollWidth > el.clientWidth + 1 }
  })
}

/** Inside the window, on the side of `edge` it opens toward, its content whole. */
function expectPopoverPlaced(name: string, box: PopoverBox, edge: { above: number } | { below: number }) {
  const numbers = JSON.stringify({ ...box, ...edge })
  expect(box.left, `${name} starts inside the window: ${numbers}`).toBeGreaterThanOrEqual(-0.5)
  expect(box.right, `${name} ends inside the window: ${numbers}`).toBeLessThanOrEqual(box.viewWidth + 0.5)
  expect(box.top, `${name} opens below the window's top: ${numbers}`).toBeGreaterThanOrEqual(-0.5)
  expect(box.bottom, `${name} ends above the window's bottom: ${numbers}`).toBeLessThanOrEqual(box.viewHeight + 0.5)
  if ('above' in edge) expect(box.bottom, `${name} sits above the status bar: ${numbers}`).toBeLessThanOrEqual(edge.above + 0.5)
  else expect(box.top, `${name} drops below the titlebar: ${numbers}`).toBeGreaterThanOrEqual(edge.below - 0.5)
  expect(box.overflowsX, `${name} shows its rows whole, with no sideways scroll: ${numbers}`).toBe(false)
}

for (const locale of Object.keys(LOCALES) as Array<keyof typeof LOCALES>) {
  test(`the status bar and its popovers fit every layout theme's minimum window (${locale})`, async ({}, testInfo) => {
    test.setTimeout(150_000 + LAYOUT_THEME_IDS.length * 45_000)
    const { app, page } = await launchApp({ locale })
    const strings = LOCALES[locale]
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
      const saveFailed: SaveStatus = { state: 'failing', revision: 1_000_000_000, since: now, last_saved_at: null, code: 'ENOSPC',
        path: '/home/u/Projects/status-layout/project.json', dir: '/home/u/Projects/status-layout' }
      await sendToRenderer(app, [
        [COMPUTE_JOBS_EVENT, jobs],
        ['media:job_started', { media_id: 'layout-probe', kind: 'proxy' }],
        ['agent_activity:changed', activity],
        ['app:notices', [NOTICE]],
        [SAVE_STATUS_EVENT, saveFailed],
      ])
      // An update on offer: main's own status handler answers it; the bell polls.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('updates:status')
        ipcMain.handle('updates:status', () => ({ phase: 'available', version: '99.0.0' }))
      })

      const bar = page.locator('.status-bar')
      const workPopover = page.locator('.work-pill-details')
      const saveFailedPopover = page.getByTestId('save-failed-details')
      const attention = page.getByTestId('attention-center')
      const win = await app.browserWindow(page)

      for (const theme of LAYOUT_THEME_IDS) {
        const tag = `${locale}-${theme}`
        await invokeCmd(page, 'app_settings_set', { patch: { layout_theme: theme } })
        await expect(page.locator('html')).toHaveAttribute('data-layout-theme', theme)

        // The minimum size main enforces for this window under this theme
        // (mainWindowGeometryDefaults, capped by the display's work area).
        const [minWidth, minHeight] = await win.evaluate((w) => {
          if (w.isFullScreen()) w.setFullScreen(false)
          if (w.isMaximized()) w.unmaximize()
          const min = w.getMinimumSize()
          w.setSize(min[0]!, min[1]!)
          return min as [number, number]
        })
        await expect.poll(() => win.evaluate((w) => w.getSize().join('x'))).toBe(`${minWidth}x${minHeight}`)
        const [contentWidth, contentHeight] = await win.evaluate((w) => w.getContentSize() as [number, number])
        const size = { theme, minWidth, minHeight, contentWidth, contentHeight }
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth)

        // The error last, so the log line shows the long message.
        await invokeCmd(page, 'log_emit', { input: { level: 'error', category: { kind: 'System' }, source: { kind: 'System' }, message: LONG_MESSAGE } })
        for (const selector of Object.values(RIGHT_ITEMS)) await expect(bar.locator(selector)).toBeVisible()
        await expect(bar.getByTestId('status-bar-log').getByTestId('status-bar-errors')).toBeVisible()
        await expect(bar.locator('.status-bar-message')).toHaveText(LONG_MESSAGE)
        // The bell's dot is the most severe item it lists: the warn notice.
        await expect(bar.getByTestId('status-bar-bell')).toHaveAttribute('data-level', NOTICE.level)

        const shot = testInfo.outputPath(`status-bar-${tag}.png`)
        await bar.screenshot({ path: shot })
        await testInfo.attach(`status-bar-${tag}`, { path: shot, contentType: 'image/png' })

        const layout = await page.evaluate((items) => {
          const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
          const footer = document.querySelector('.status-bar')!
          const message = footer.querySelector<HTMLElement>('.status-bar-message')!
          return {
            bar: rect(footer),
            log: rect(footer.querySelector('[data-testid="status-bar-log"]')!),
            right: rect(footer.querySelector('.status-bar-right')!),
            items: Object.fromEntries(Object.entries(items).map(([name, selector]) => {
              const el = footer.querySelector<HTMLElement>(selector)!
              // Every line box the item's content lays out on: wrapped content
              // has one starting below another's bottom.
              const range = document.createRange()
              range.selectNodeContents(el)
              const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
              const wraps = lines.length > 1 && Math.max(...lines.map((r) => r.top)) >= Math.min(...lines.map((r) => r.bottom))
              return [name, { ...rect(el), wraps, clipped: el.scrollWidth > el.clientWidth + 1 }]
            })),
            message: { scrollWidth: message.scrollWidth, clientWidth: message.clientWidth, textOverflow: getComputedStyle(message).textOverflow },
          }
        }, RIGHT_ITEMS)
        await testInfo.attach(`status-bar-${tag}-layout`, { body: JSON.stringify({ size, ...layout }, null, 2), contentType: 'application/json' })

        // The three popovers in turn, each captured before any assertion so
        // the screenshots survive a failure. Opening one closes the other;
        // Escape and a second click on the trigger close too.
        const capture = async (name: string) => {
          const path = testInfo.outputPath(`${name}-${tag}.png`)
          await page.screenshot({ path, scale: 'css' })
          await testInfo.attach(`${name}-${tag}`, { path, contentType: 'image/png' })
        }

        // Work: the clip job, the agent call and the derivative job, each under its own group.
        await bar.locator(RIGHT_ITEMS.work).click()
        await expect(workPopover).toBeVisible()
        await expect(workPopover.locator('.work-group')).toHaveCount(3)
        await capture('work-popover')
        const workBox = await popoverBox(workPopover)
        await page.keyboard.press('Escape')
        await expect(workPopover).toHaveCount(0)

        // Save failed: the reason and the three ways out.
        await bar.locator(RIGHT_ITEMS.saveFailed).click()
        await expect(saveFailedPopover).toBeVisible()
        await expect(saveFailedPopover.getByRole('button')).toHaveCount(3)
        await capture('save-failed-popover')
        const saveFailedBox = await popoverBox(saveFailedPopover)

        // The bell, opened over Save failed: the review, the update and the notice.
        await bar.locator(RIGHT_ITEMS.bell).click()
        await expect(saveFailedPopover).toHaveCount(0)
        await expect(attention).toBeVisible()
        for (const key of ['review', 'update', `notice:${NOTICE.code}`]) await expect(attention.locator(`[data-attention="${key}"]`)).toBeVisible()
        await capture('attention-popover')
        const attentionBox = await popoverBox(attention)
        await bar.locator(RIGHT_ITEMS.bell).click()
        await expect(attention).toHaveCount(0)

        // Agent mode at the same size: its titlebar holds every item it can show
        // at once (Save failed, the exit button, the bell, the caption buttons off
        // macOS). Captured before any assertion, so the screenshots survive a failure.
        await page.locator('.menu-trigger').nth(2).click()
        await page.locator('.app-menu-item').filter({ hasText: new RegExp(`^${strings.view.enter_agent_mode}$`) }).click()
        const titlebar = page.locator('.agent-titlebar')
        await expect(titlebar.getByTestId('save-failed-pill')).toBeVisible()
        await expect(titlebar.getByTestId('status-bar-bell')).toBeVisible()
        await expect(titlebar.locator('.agent-exit-button')).toBeVisible()
        if (process.platform !== 'darwin') await expect(titlebar.locator('.window-controls')).toBeVisible()
        const titlebarShot = testInfo.outputPath(`agent-titlebar-${tag}.png`)
        await titlebar.screenshot({ path: titlebarShot })
        await testInfo.attach(`agent-titlebar-${tag}`, { path: titlebarShot, contentType: 'image/png' })
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
              // A popover anchor is named by the trigger inside it.
              const name = html.dataset.testid ?? html.querySelector<HTMLElement>('[data-testid]')?.dataset.testid ?? html.className
              return { name, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                width: box.width, wraps, clipped: html.scrollWidth > html.clientWidth + 1 }
            }).filter((item) => item.width > 0),
          }
        })
        await testInfo.attach(`agent-titlebar-${tag}-layout`, { body: JSON.stringify({ size, ...agentBar }, null, 2), contentType: 'application/json' })

        // Both titlebar popovers drop down, in place: agent mode stays.
        await titlebar.getByTestId('save-failed-pill').click()
        await expect(saveFailedPopover).toBeVisible()
        await capture('agent-save-failed-popover')
        const agentSaveFailedBox = await popoverBox(saveFailedPopover)
        await titlebar.getByTestId('status-bar-bell').click()
        await expect(saveFailedPopover).toHaveCount(0)
        await expect(attention).toBeVisible()
        await capture('agent-attention-popover')
        const agentAttentionBox = await popoverBox(attention)
        await page.keyboard.press('Escape')
        await expect(attention).toHaveCount(0)
        await expect(page.locator('.agent-mode-shell')).toBeVisible()
        await page.locator('.agent-exit-button').click()
        await expect(page.locator('.agent-mode-shell')).toHaveCount(0)

        // The status bar: one row, the right group whole and inside the bar,
        // the log line giving way by truncating its message.
        const numbers = JSON.stringify({ size, bar: layout.bar, log: layout.log, right: layout.right })
        const centre = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2
        const rowCentre = centre(layout.items.bell)
        expect(layout.right.left, `[${tag}] the right group starts inside the bar: ${numbers}`).toBeGreaterThanOrEqual(layout.bar.left - 0.5)
        expect(layout.right.right, `[${tag}] the right group ends inside the bar: ${numbers}`).toBeLessThanOrEqual(layout.bar.right + 0.5)
        expect(layout.log.right, `[${tag}] the log line ends before the right group: ${numbers}`).toBeLessThanOrEqual(layout.right.left + 0.5)
        for (const [name, item] of Object.entries(layout.items)) {
          expect(item.top, `[${tag}] ${name} inside the bar's height: ${numbers}`).toBeGreaterThanOrEqual(layout.bar.top - 0.5)
          expect(item.bottom, `[${tag}] ${name} inside the bar's height: ${numbers}`).toBeLessThanOrEqual(layout.bar.bottom + 0.5)
          expect(Math.abs(centre(item) - rowCentre), `[${tag}] ${name} shares the bar's one row`).toBeLessThanOrEqual(1)
          expect(item.wraps, `[${tag}] ${name} keeps its content on one line`).toBe(false)
          expect(item.clipped, `[${tag}] ${name} shows its whole content: ${numbers}`).toBe(false)
        }
        const rightOrdered = Object.entries(layout.items).sort(([, a], [, b]) => a.left - b.left)
        for (let i = 1; i < rightOrdered.length; i++) {
          const [prevName, prev] = rightOrdered[i - 1]!
          const [name, item] = rightOrdered[i]!
          expect(item.left, `[${tag}] ${prevName} overlaps ${name}: ${numbers}`).toBeGreaterThanOrEqual(prev.right - 0.5)
        }
        expect(layout.message.textOverflow).toBe('ellipsis')
        expect(layout.message.scrollWidth, `[${tag}] the log message truncates rather than pushing items out`).toBeGreaterThan(layout.message.clientWidth)

        expectPopoverPlaced(`[${tag}] the work popover`, workBox, { above: layout.bar.top })
        expectPopoverPlaced(`[${tag}] the Save failed popover`, saveFailedBox, { above: layout.bar.top })
        expectPopoverPlaced(`[${tag}] the notification center`, attentionBox, { above: layout.bar.top })

        // The titlebar has no text meant to truncate: its free space (the drag
        // strip on the left) is what gives way, so every item keeps its full
        // content, inside the bar, on one row, overlapping none of the others.
        const agentNumbers = JSON.stringify({ size, ...agentBar })
        const agentRow = (agentBar.bar.top + agentBar.bar.bottom) / 2
        for (const item of agentBar.items) {
          expect(item.left, `[${tag}] ${item.name} starts inside the titlebar: ${agentNumbers}`).toBeGreaterThanOrEqual(agentBar.bar.left - 0.5)
          expect(item.right, `[${tag}] ${item.name} ends inside the titlebar: ${agentNumbers}`).toBeLessThanOrEqual(agentBar.bar.right + 0.5)
          expect(item.top, `[${tag}] ${item.name} inside the titlebar's height`).toBeGreaterThanOrEqual(agentBar.bar.top - 0.5)
          expect(item.bottom, `[${tag}] ${item.name} inside the titlebar's height`).toBeLessThanOrEqual(agentBar.bar.bottom + 0.5)
          expect(Math.abs(centre(item) - agentRow), `[${tag}] ${item.name} shares the titlebar's one row: ${agentNumbers}`).toBeLessThanOrEqual(1)
          expect(item.wraps, `[${tag}] ${item.name} keeps its content on one line`).toBe(false)
          expect(item.clipped, `[${tag}] ${item.name} shows its whole content: ${agentNumbers}`).toBe(false)
        }
        const ordered = [...agentBar.items].sort((a, b) => a.left - b.left)
        for (let i = 1; i < ordered.length; i++) {
          expect(ordered[i]!.left, `[${tag}] ${ordered[i - 1]!.name} overlaps ${ordered[i]!.name}: ${agentNumbers}`).toBeGreaterThanOrEqual(ordered[i - 1]!.right - 0.5)
        }
        expectPopoverPlaced(`[${tag}] agent mode's Save failed popover`, agentSaveFailedBox, { below: agentBar.bar.bottom })
        expectPopoverPlaced(`[${tag}] agent mode's notification center`, agentAttentionBox, { below: agentBar.bar.bottom })
      }
    } finally {
      await client?.close().catch(() => {})
      await app.close()
    }
  })
}
