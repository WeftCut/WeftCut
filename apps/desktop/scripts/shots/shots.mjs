#!/usr/bin/env node
// PR screenshots: run a shot file against a running app (--cdp) or a build it
// launches (this checkout's, or --app <apps/desktop>), write one PNG per shot
// and the PR-body section that puts before and after side by side.
// See docs/agents/screenshots.md.
//
//   node scripts/shots/shots.mjs run <file.mjs> [--cdp <port> | --app dir] [--side before|after]
//        [--label main] [--out dir] [--only name] [--no-data] [--watch]
//   node scripts/shots/shots.mjs pick [--cdp <port> | --app dir] [--within sel] [--at x,y] [--filter text]
//   node scripts/shots/shots.mjs keys <ui text>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  DESKTOP, applyAppSettings, applyViewport, capture, connectMcp, findKeys, invoke, loadData, localeTable, makeUi,
  prSection, scanTargets, scratchDir, shotFile, shotId,
} from './lib.mjs'

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    cdp: { type: 'string' },
    app: { type: 'string' },
    side: { type: 'string', default: 'after' },
    label: { type: 'string' },
    out: { type: 'string' },
    only: { type: 'string' },
    'no-data': { type: 'boolean', default: false },
    watch: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    within: { type: 'string' },
    at: { type: 'string' },
    filter: { type: 'string' },
  },
})
const [command, file] = positionals
const log = (...a) => console.log('[shots]', ...a)

/** The app's main window: the page that holds the editor shell, not a capture
 *  or side window. */
async function mainPage(context) {
  for (let i = 0; i < 40; i++) {
    for (const p of context.pages()) {
      if (await p.locator('.dock-workspace, .agent-mode-shell, .startup-screen, #root').count().catch(() => 0)) return p
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('no editor window found')
}

/** Attach to a running app, or launch one: `--app` names an apps/desktop
 *  directory with a built `out/` (default: this checkout); the shot file's
 *  theme and language are written to a scratch profile before launch, since
 *  the layout theme only applies at launch. */
async function openApp(appOpts = {}) {
  const pw = await import('playwright-core')
  const chromium = pw.chromium ?? pw.default.chromium
  if (opt.cdp) {
    const url = /^\d+$/.test(opt.cdp) ? `http://127.0.0.1:${opt.cdp}` : opt.cdp
    const browser = await chromium.connectOverCDP(url)
    const page = await mainPage(browser.contexts()[0])
    return { page, close: () => browser.close() }
  }
  const electron = pw._electron ?? pw.default._electron
  const dir = path.resolve(opt.app || DESKTOP)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-shots-profile-'))
  const settings = { ...(appOpts.settings ?? {}) }
  if (appOpts.theme) settings.layout_theme = appOpts.theme
  fs.writeFileSync(path.join(profile, 'app_settings.json'), JSON.stringify(settings))
  const gl = process.platform === 'linux' ? ['--enable-unsafe-swiftshader'] : []
  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, ...gl, path.join(dir, 'out/main/index.js')],
    cwd: dir,
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' },
  })
  const page = await mainPage(app.context())
  await page.waitForLoadState('domcontentloaded')
  return {
    page,
    close: async () => { if (!opt.keep) { await app.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }) } },
  }
}

async function loadShotFile(f) {
  const mod = await import(`${pathToFileURL(path.resolve(f)).href}?t=${Date.now()}`)
  const spec = mod.default
  if (!spec?.shots?.length) throw new Error(`${f}: default export needs a non-empty shots list`)
  // Paths in a shot file are relative to the file.
  const near = (p) => typeof p === 'string' ? path.resolve(path.dirname(path.resolve(f)), p) : p
  if (spec.data) spec.data = { ...spec.data, project: near(spec.data.project), setup: near(spec.data.setup) }
  return spec
}

async function run() {
  if (!file) throw new Error('run needs a shot file')
  if (!['before', 'after'].includes(opt.side)) throw new Error('--side is before or after')
  const spec = await loadShotFile(file)
  const out = path.resolve(opt.out ?? path.join(path.dirname(path.resolve(file)), 'shots-out', path.basename(file).replace(/\.\w+$/, '')))
  fs.mkdirSync(out, { recursive: true })
  const app = spec.app ?? {}
  const languages = [].concat(app.language ?? [null])
  const session = await openApp(app)
  const { page } = session
  // A step that cannot find its element is usually a before side that lacks
  // it; fail it fast rather than at Playwright's 30 s default.
  page.setDefaultTimeout(spec.stepTimeout ?? 8000)
  const mcp = await connectMcp(page)
  const resetViewport = await applyViewport(page, app)
  const manifest = { side: opt.side, label: opt.label ?? (opt.side === 'before' ? 'main' : 'this branch'), languages: languages.map(l => l ?? 'app'), entries: [] }
  let restore = {}
  try {
    for (const lang of languages) {
      const r = await applyAppSettings(page, app, lang)
      restore = { ...r, ...restore }
      const langTag = lang ?? (await invoke(page, 'app_settings_get')).language ?? 'app'
      if (!opt['no-data']) await loadData(page, mcp, spec.data, { scratch: scratchDir(), log })
      const ui = await makeUi(page, langTag)
      const picked = (i, shot) => !opt.only || shotId(i, shot.name).includes(opt.only) || shot.name === opt.only
      const last = spec.shots.findLastIndex((s, i) => picked(i, s))
      for (const [i, shot] of spec.shots.entries()) {
        if (i > last) break
        const id = shotId(i, shot.name)
        if (!picked(i, shot)) {
          // Shots build on the state the earlier ones leave: replay their
          // steps without capturing.
          if (shot.fresh && !opt['no-data']) await loadData(page, mcp, spec.data, { scratch: scratchDir(), log })
          if (shot.steps && !opt['no-data']) await shot.steps({ ui, page, mcp, t: ui.t }).catch(e => log(`step ${id}: ${e.message.split('\n')[0]}`))
          continue
        }
        const entry = { id, name: shot.name, caption: shot.caption ?? '', lang: langTag, file: shotFile(opt.side, langTag, id), ok: false }
        if (shot.fresh && i > 0 && !opt['no-data']) await loadData(page, mcp, spec.data, { scratch: scratchDir(), log })
        try {
          if (shot.steps) await shot.steps({ ui, page, mcp, t: ui.t })
          entry.clip = await capture(page, shot, path.join(out, entry.file), { deviceScale: !!app.scale })
          entry.ok = true
          log(`ok   ${entry.file}${entry.clip ? ` ${entry.clip.width}x${entry.clip.height}` : ''}`)
        } catch (e) {
          entry.error = String(e.message ?? e).split('\n')[0].slice(0, 200)
          log(`FAIL ${id} (${langTag}): ${entry.error}`)
          if (opt.side === 'after') await page.screenshot({ path: path.join(out, `failed-${langTag}-${id}.png`) }).catch(() => {})
        }
        manifest.entries.push(entry)
      }
    }
  } finally {
    if (Object.keys(restore).length && opt.cdp) await invoke(page, 'app_settings_set', { patch: restore }).catch(() => {})
    await resetViewport()
    await mcp.close().catch(() => {})
    await session.close()
  }
  const manifestFile = path.join(out, `${opt.side}.json`)
  if (opt.only && fs.existsSync(manifestFile)) {
    // A partial rerun replaces its own entries and keeps the rest, in shot order.
    const kept = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).entries
      .filter(e => !manifest.entries.some(n => n.id === e.id && n.lang === e.lang))
    manifest.entries = [...kept, ...manifest.entries].sort((a, b) => a.id.localeCompare(b.id) || a.lang.localeCompare(b.lang))
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  writeReport(out)
  return manifest.entries.every(e => e.ok || opt.side === 'before')
}

function writeReport(out) {
  const read = (side) => { const f = path.join(out, `${side}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }
  const { markdown, files } = prSection({ before: read('before'), after: read('after') })
  if (!markdown) return
  fs.writeFileSync(path.join(out, 'pr.md'), markdown + '\n')
  fs.writeFileSync(path.join(out, 'attach.txt'), files.map(f => `--attach ${f}`).join(' ') + '\n')
  log(`report ${path.join(out, 'pr.md')} (${files.length} images; from ${out}: gh pr edit <n> --body-file <body.md> $(cat attach.txt))`)
}

async function pick() {
  const session = await openApp()
  try {
    const at = opt.at ? opt.at.split(',').map(Number) : null
    let lines = await scanTargets(session.page, { within: opt.within ?? null, at })
    if (opt.filter) lines = lines.filter(l => l.toLowerCase().includes(opt.filter.toLowerCase()))
    console.log(lines.slice(0, 150).join('\n'))
    if (lines.length > 150) console.log(`… ${lines.length - 150} more; narrow with --within or --filter`)
  } finally { await session.close() }
}

async function keys() {
  if (!file) throw new Error('keys needs the text to look for')
  const lines = []
  for (const lang of ['en-US', 'zh-CN']) lines.push(...findKeys(await localeTable(lang), file).map(l => `${lang}  ${l}`))
  console.log(lines.length ? lines.join('\n') : `no UI text contains "${file}"`)
}

async function main() {
  if (command === 'pick') return pick()
  if (command === 'keys') return keys()
  if (command !== 'run') {
    console.log('usage: shots.mjs run <file> [--cdp port] [--side before|after] | pick [--cdp port] | keys <text>')
    process.exit(2)
  }
  let ok = await run()
  if (!opt.watch) process.exit(ok ? 0 : 1)
  log(`watching ${file}`)
  let timer = null
  fs.watch(path.resolve(file), () => {
    clearTimeout(timer)
    timer = setTimeout(async () => { try { ok = await run() } catch (e) { log(`error: ${e.message}`) } }, 300)
  })
}

main().catch((e) => { console.error('[shots]', e.message ?? e); process.exit(1) })
