// PR screenshot tool: the parts a shot file reaches (ui helpers, data loading,
// capture) and the pure pieces the CLI composes (box union, report).
// Usage and the shot-file format: docs/agents/screenshots.md.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DESKTOP = path.resolve(HERE, '../..')
const LOCALES = path.join(DESKTOP, 'src/renderer/i18n/locales')
const MEDIA = path.join(DESKTOP, 'e2e/fixtures/media')

// ── pure ─────────────────────────────────────────────────────────────────

/** The smallest box holding every box, grown by `pad` and kept inside the
 *  viewport. Null when there are no boxes. */
export function unionBox(boxes, pad = 0, viewport = null) {
  if (!boxes.length) return null
  let x0 = Math.min(...boxes.map(b => b.x)) - pad
  let y0 = Math.min(...boxes.map(b => b.y)) - pad
  let x1 = Math.max(...boxes.map(b => b.x + b.width)) + pad
  let y1 = Math.max(...boxes.map(b => b.y + b.height)) + pad
  if (viewport) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0)
    x1 = Math.min(viewport.width, x1); y1 = Math.min(viewport.height, y1)
  }
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - Math.floor(x0)), height: Math.ceil(y1 - Math.floor(y0)) }
}

/** File-safe id for a shot: its position plus the ASCII part of its name, so
 *  two non-ASCII names never collide. */
export function shotId(index, name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${String(index + 1).padStart(2, '0')}${slug ? '-' + slug : ''}`
}

export const shotFile = (side, lang, id) => `${side}-${lang}-${id}.png`

/** A UI string for `keyOrText` in `table`: a dotted i18n key resolves to its
 *  text (interpolations become wildcards, so the result may be a RegExp);
 *  anything else is literal text. */
export function resolveText(table, keyOrText) {
  if (keyOrText instanceof RegExp) return keyOrText
  const hit = String(keyOrText).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), table)
  if (typeof hit !== 'string') return String(keyOrText)
  if (!hit.includes('{{')) return hit
  return new RegExp(hit.split(/\{\{[^}]*\}\}/).map(escapeRe).join('.*'))
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An accessible-name matcher that tolerates trailing text such as a shortcut
 *  hint ("进入代理模式 Ctrl+Shift+A"). */
export function nameMatcher(text) {
  if (text instanceof RegExp) return text
  return new RegExp('^\\s*' + escapeRe(text))
}

/** The PR-body section for one run directory: per shot and language, a
 *  Before | After table when both sides exist, the after image alone
 *  otherwise. `manifests` maps side → its manifest (see runShots). Returns the
 *  markdown and the files it references, in order, for `gh --attach`. */
export function prSection(manifests) {
  const after = manifests.after
  if (!after) return { markdown: '', files: [] }
  const before = manifests.before
  const files = []
  const lines = []
  const ref = (e, alt) => { files.push(`./${e.file}`); return `![${alt}](./${e.file})` }
  for (const e of after.entries) {
    const title = e.caption || e.name
    lines.push(`**${title}**${after.languages.length > 1 ? ` (${e.lang})` : ''}`, '')
    const b = before?.entries.find(x => x.id === e.id && x.lang === e.lang)
    if (!e.ok) { lines.push(`After: not captured (${e.error})`, ''); continue }
    if (!before) { lines.push(ref(e, title), ''); continue }
    const left = b?.ok ? ref(b, `${title}, before`) : `not on ${before.label}`
    lines.push(`| Before (${before.label}) | After |`, '|---|---|', `| ${left} | ${ref(e, `${title}, after`)} |`, '')
  }
  return { markdown: lines.join('\n'), files }
}

// ── app session ──────────────────────────────────────────────────────────

/** Every i18n key whose text contains `text`, as `key  text` lines. */
export function findKeys(table, text, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(table ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') { if (v.toLowerCase().includes(text.toLowerCase())) out.push(`${key}  ${v.slice(0, 60)}`) }
    else if (v && typeof v === 'object') out.push(...findKeys(v, text, key))
  }
  return out
}

const locales = new Map()
export async function localeTable(lang) {
  if (!locales.has(lang)) {
    const file = path.join(LOCALES, `${lang}.ts`)
    locales.set(lang, fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : {})
  }
  return locales.get(lang)
}

export const invoke = (page, cmd, args = {}) =>
  page.evaluate(([c, a]) => window.api.backend.invoke(c, a), [cmd, args])

/** MCP client over the app's own loopback endpoint. */
export async function connectMcp(page) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const info = await page.evaluate(() => window.api.mcp.getInfo())
  const client = new Client({ name: 'PR shots', version: '1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  }))
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    if (r.isError) throw new Error(`${name}: ${r.content?.map(c => c.text).join(' ')}`)
    return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? 'null')
  }
  const read = async (uri) => JSON.parse((await client.readResource({ uri })).contents[0].text)
  // end_agent_session holds once when the session audit has findings
  // (`ended: false`); the second call ends it.
  const endSession = async () => {
    const r = await call('end_agent_session', {}).catch(() => null)
    if (r?.ended === false) await call('end_agent_session', {}).catch(() => {})
  }
  return { client, call, read, endSession, close: () => client.close() }
}

/** Step helpers handed to a shot file. Strings are i18n keys or literal text;
 *  selectors are Playwright selectors. Clicks are real pointer events, which
 *  menus need. */
export async function makeUi(page, lang) {
  const table = await localeTable(lang)
  const t = (k) => resolveText(table, k)
  const name = (k) => nameMatcher(t(k))
  const visible = (loc) => loc.filter({ visible: true }).first()
  const menuEntry = (k) => visible(page.locator('button, [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]')
    .filter({ hasText: name(k) }))
  return {
    page,
    t,
    /** Open a menu path: the top entry, then each item, by key or text. */
    async menu(...items) { for (const k of items) await menuEntry(k).click() },
    tab: (k) => visible(page.getByRole('tab', { name: name(k) })).click(),
    button: (k) => visible(page.getByRole('button', { name: name(k) })).click(),
    click: (sel, opts) => visible(page.locator(sel)).click(opts),
    dbl: (sel, opts) => visible(page.locator(sel)).dblclick(opts),
    hover: (sel) => visible(page.locator(sel)).hover(),
    key: (k) => page.keyboard.press(k),
    type: (s) => page.keyboard.type(s),
    /** Wait for a selector to be visible, or a number of milliseconds. */
    wait: (x) => typeof x === 'number' ? page.waitForTimeout(x) : page.locator(x).first().waitFor({ state: 'visible' }),
    text: (k) => visible(page.getByText(t(k))),
  }
}

/** Apply the shot file's `app` block to a running app. Returns the settings
 *  patch that restores what it changed. */
export async function applyAppSettings(page, app, lang) {
  const now = await invoke(page, 'app_settings_get')
  if (app.theme && now.layout_theme !== app.theme) {
    throw new Error(`layout theme ${app.theme} takes effect at launch; this app runs ${now.layout_theme}. Relaunch it with that theme (--app writes it before launch).`)
  }
  const patch = { ...(app.settings ?? {}), ...(lang ? { language: lang } : {}) }
  const restore = Object.fromEntries(Object.keys(patch).map(k => [k, now[k] ?? null]))
  const changed = Object.keys(patch).some(k => JSON.stringify(now[k]) !== JSON.stringify(patch[k]))
  if (changed) {
    await invoke(page, 'app_settings_set', { patch })
    if (lang) await page.waitForFunction((l) => document.documentElement.lang === l || document.documentElement.lang.startsWith(l.split('-')[0]), lang, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(300)
  }
  return restore
}

/** Viewport size for every capture; `app.scale` sets a device scale (2 for
 *  sharper crops). Without it captures are in CSS pixels whatever the host's
 *  display scaling (see capture). */
export async function applyViewport(page, app) {
  if (!app.size && !app.scale) return async () => {}
  const cdp = await page.context().newCDPSession(page)
  const [width, height] = app.size ?? [0, 0]
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: app.scale ?? 0, mobile: false })
  return async () => { await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {}); await cdp.detach().catch(() => {}) }
}

/** Open the shot file's data in the app.
 *   { project: dir }          a copy of an existing project folder
 *   { canvas, setup }         a fresh project, then `setup(ctx)` (MCP calls)
 *   { project, setup }        the copy, then `setup(ctx)`
 *   undefined                 whatever the app has open now */
export async function loadData(page, mcp, data, { scratch, log }) {
  if (!data) return null
  await mcp.endSession()
  // Every run copies its media into a new scratch project; drop the earlier
  // ones, all but the project the app holds open.
  const open = (await mcp.read('project://session').catch(() => null))?.project?.dir
  for (const name of fs.readdirSync(scratch)) {
    const p = path.join(scratch, name)
    if (open && path.resolve(p).toLowerCase() === path.resolve(open).toLowerCase()) continue
    try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* in use: next run */ }
  }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(4, 14)
  let dir
  if (data.project) {
    const src = path.resolve(data.project)
    dir = path.join(scratch, `${path.basename(src)}-${stamp}`)
    fs.cpSync(src, dir, { recursive: true })
    await mcp.call('open_project', { path: dir })
  } else {
    const [width, height, fps] = data.canvas ?? [1280, 720, 30]
    const made = await mcp.call('create_project', { name: `shots-${stamp}`, parent_folder: scratch, width, height, fps: { num: fps, den: 1 } })
    dir = made.dir
  }
  log(`project ${dir}`)
  await waitForProject(page, mcp, dir)
  const ctx = {
    mcp, page, dir,
    fixture: (name) => path.join(MEDIA, name),
    /** Leave for a scratch project and come back: the review baseline resets
     *  to what is on disk now. */
    async reopen() {
      await mcp.endSession()
      await mcp.call('create_project', { name: `shots-scratch-${stamp}`, parent_folder: scratch, width: 640, height: 360, fps: { num: 30, den: 1 } })
      await mcp.call('open_project', { path: dir })
      await waitForProject(page, mcp, dir)
    },
  }
  const setup = typeof data.setup === 'string' ? (await import(pathToFileURL(path.resolve(data.setup)).href)).default : data.setup
  if (setup) await setup(ctx)
  await mcp.endSession()
  return dir
}

async function waitForProject(page, mcp, dir) {
  const want = path.resolve(dir).toLowerCase()
  for (let i = 0; i < 60; i++) {
    const s = await mcp.read('project://session').catch(() => null)
    const open = s?.project?.dir ?? s?.dir
    if (open && path.resolve(open).toLowerCase() === want) break
    await page.waitForTimeout(250)
  }
  await page.locator('.splash-screen').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(800)
}

export const scratchDir = () => {
  const dir = path.join(os.tmpdir(), 'weftcut-shots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Applied only while capturing: dev and e2e builds float a splash toggle over
 *  the bottom-left corner (main.tsx showSplashDebugControl) that a release
 *  build never shows. */
const CAPTURE_STYLE = '.dev-splash-toggle { visibility: hidden !important; }'

/** Capture `shot.target` (a selector, a list of them, or none for the whole
 *  window) after the page settles: pointer moved off the UI unless
 *  `shot.hover`, fonts loaded, two frames, animations finished. */
export async function capture(page, shot, file, { deviceScale = false } = {}) {
  if (!shot.hover) await page.mouse.move(-1, -1)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  await page.waitForTimeout(shot.settle ?? 300)
  const targets = shot.target == null ? [] : [].concat(shot.target)
  let clip
  if (targets.length) {
    const boxes = []
    for (const t of targets) {
      const loc = page.locator(t)
      const n = await loc.count()
      for (let i = 0; i < n; i++) {
        const b = await loc.nth(i).boundingBox()
        if (b && b.width > 0 && b.height > 0) boxes.push(b)
      }
    }
    // A list frames whichever of its parts exist, so one shot file serves a
    // before side that lacks an element the change adds.
    if (!boxes.length) throw new Error(`no target on screen: ${targets.join(', ')}`)
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    clip = unionBox(boxes, shot.pad ?? 8, viewport)
  }
  // CSS pixels unless a device scale was asked for: a host at 110 % display
  // scaling otherwise makes every image 1.1x and no two hosts agree on size.
  await page.screenshot({ path: file, clip, animations: 'disabled', caret: 'hide', scale: deviceScale ? 'device' : 'css', style: CAPTURE_STYLE })
  return clip ?? null
}

/** Candidate targets on screen, one line each: a selector, its text and box.
 *  `within` limits the scan to a subtree; `at` lists the element chain under
 *  a point instead. */
export function scanTargets(page, { within = null, at = null } = {}) {
  return page.evaluate(({ within, at }) => {
    const roles = new Set(['button', 'tab', 'tablist', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'dialog', 'toolbar', 'region', 'slider', 'checkbox', 'switch', 'listbox', 'option', 'tree', 'treeitem', 'status'])
    const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const firstClass = (el) => [...el.classList].find(c => /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(c))
    const selectorOf = (el) => {
      const tid = el.getAttribute('data-testid')
      if (tid) return `[data-testid="${tid}"]`
      const role = el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : null)
      const name = label(el)
      if (role && roles.has(role) && name) return `role=${role}[name="${name.replace(/"/g, '\\"')}"]`
      const c = firstClass(el)
      return c ? `.${c}` : null
    }
    const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : null }
    const line = (el, r, depth = 0) => {
      const sel = selectorOf(el)
      if (!sel) return null
      const count = sel.startsWith('.') ? document.querySelectorAll(sel).length : 1
      return `${'  '.repeat(depth)}${sel}${count > 1 ? ` (x${count})` : ''}  "${label(el)}"  ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
    }
    if (at) {
      return document.elementsFromPoint(at[0], at[1]).reverse().map((el, i) => { const r = box(el); return r ? line(el, r, Math.min(i, 12)) : null }).filter(Boolean)
    }
    const root = within ? document.querySelector(within) : document.body
    if (!root) return [`no element matches ${within}`]
    const out = []
    const seen = new Set()
    for (const el of root.querySelectorAll('*')) {
      const r = box(el)
      if (!r || r.width < 12 || r.height < 10) continue
      const interesting = el.hasAttribute('data-testid') || roles.has(el.getAttribute('role') ?? '') || el.tagName === 'BUTTON' ||
        (firstClass(el) && firstClass(el) !== firstClass(el.parentElement ?? el) && r.width * r.height > 2000)
      if (!interesting) continue
      const l = line(el, r)
      if (l && !seen.has(l)) { seen.add(l); out.push(l) }
    }
    return out
  }, { within, at })
}
