// apps/desktop/bench/templates.mjs
//
// Project templates: a task's project after setup and media settling, saved
// with its derived caches (the project folder's Cache/: proxies, waveforms,
// thumbnails, conformed audio) so later runs copy it and open_project it
// instead of importing and transcoding again. A 3.5-minute 1080p explainer
// costs ~16 minutes of media jobs on a two-core host; a copy costs seconds.
//
// The key is the setup's CONTENT, so tasks that set up the same project share
// one template (the three explainer tasks do; so do the three interview ones):
//   - the project settings and the setup calls, verbatim (canonical JSON);
//   - each fixture's MP4 sha256 as fetched on that host (fixture.json) — the
//     transcode is not byte-pinned, so the bytes actually imported decide;
//   - the project's name, which is derived from the fixtures, never from the
//     task: a shared project must not carry one task's id (and an agent should
//     not read its task's name off the project);
//   - the app build (the host reports a revision and a build fingerprint);
//   - the host kind and identity: templates live on the host that built them.
// A label (tasks.txt beside the template) lists the task ids that used it.
//
// After a copy is opened, its baseline must equal the fresh build's modulo
// the project folder's location; `compareBaselines` says where it does not.

import { createHash } from 'node:crypto'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** Stable JSON: object keys sorted, so key order in a task file is not part of
 *  the key. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}

/** The project a task's setup creates is named after its fixtures (or, for a
 *  synthetic task, the task itself), so identical setups make identical
 *  projects. */
export function projectNameFor(task) {
  return task.fixtures.length ? [...task.fixtures].sort().join('--') : task.id
}

/**
 * @param {{ task: { id: string, fixtures: string[], project: unknown, setup: unknown[] },
 *           fixtureHashes: Record<string, string>, app: { revision: string | null, build: string },
 *           host: string }} parts  fixtureHashes: each fixture's MP4 sha256 on that host
 * @returns {{ key: string, parts: Record<string, unknown> }}
 */
export function templateKey({ task, fixtureHashes, app, host }) {
  const fixtures = Object.fromEntries([...task.fixtures].sort().map((id) => {
    const h = fixtureHashes[id]
    if (!h) throw new Error(`no output hash for fixture ${id}`)
    return [id, h]
  }))
  const name = projectNameFor(task)
  const setup = { name, project: task.project, setup: task.setup, fixtures }
  const parts = { setup_sha256: sha256(canonicalJson(setup)), fixtures, app_revision: app.revision, app_build: app.build, host }
  return { key: `${name}-${sha256(canonicalJson(parts)).slice(0, 16)}`, parts }
}

/** Fields that differ between two openings of the same project for reasons
 *  that are not content: when it was last saved. */
const VOLATILE = new Set(['modified_at'])

/** A baseline with the project folder's location replaced by `<project>` and
 *  separators unified, volatile fields dropped. `projectDir` in the host's own
 *  spelling. */
export function normalizeBaseline(baseline, projectDir) {
  const variants = [projectDir, projectDir.replace(/\\/g, '/'), projectDir.replace(/\//g, '\\')]
  const re = new RegExp(variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  const walk = (v) => {
    if (typeof v === 'string') {
      re.lastIndex = 0
      return re.test(v) ? v.replace(re, '<project>').replace(/\\/g, '/') : v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) if (!VOLATILE.has(k)) out[k] = walk(x)
      return out
    }
    return v
  }
  return walk(baseline)
}

/** Paths (JSON-pointer-ish) where two normalized baselines differ; at most
 *  `limit` of them. Empty means equivalent. */
export function diffJson(a, b, limit = 50, at = '') {
  const out = []
  const visit = (x, y, p) => {
    if (out.length >= limit) return
    if (x === y) return
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object' || Array.isArray(x) !== Array.isArray(y)) {
      out.push({ path: p || '/', template: x, copy: y })
      return
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    for (const k of [...keys].sort()) visit(x[k], y[k], `${p}/${k}`)
  }
  visit(a, b, at)
  return out
}

/** Whether the copy's baseline is the fresh build's, modulo where each lived. */
export function compareBaselines(fresh, freshDir, copy, copyDir) {
  const differences = diffJson(normalizeBaseline(fresh, freshDir), normalizeBaseline(copy, copyDir))
  return { equivalent: differences.length === 0, differences }
}
