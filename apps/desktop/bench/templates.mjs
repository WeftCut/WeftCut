// apps/desktop/bench/templates.mjs
//
// Project templates: a task's project after setup and media settling, saved
// with its derived caches (the project folder's Cache/: proxies, waveforms,
// thumbnails, conformed audio) so later runs copy it and open_project it
// instead of importing and transcoding again. A 3.5-minute 1080p explainer
// costs ~16 minutes of media jobs on a two-core host; a copy costs seconds.
//
// The key names everything the settled project depends on:
//   - the task's setup-relevant fields (id → folder name, fixtures, project,
//     setup); prompt and checklist edits do not invalidate a template;
//   - each fixture's pinned content hash (fixtures.json);
//   - the app build (the host reports a revision and a build fingerprint);
//   - the host kind and identity: templates live on the host that built them.
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

/**
 * @param {{ task: { id: string, fixtures: string[], project: unknown, setup: unknown[] },
 *           fixtureHashes: Record<string, string>, app: { revision: string | null, build: string },
 *           host: string }} parts
 * @returns {{ key: string, parts: Record<string, unknown> }}
 */
export function templateKey({ task, fixtureHashes, app, host }) {
  const setup = { id: task.id, fixtures: task.fixtures, project: task.project, setup: task.setup }
  const parts = {
    setup_sha256: sha256(canonicalJson(setup)),
    fixtures: Object.fromEntries(task.fixtures.map((id) => {
      const h = fixtureHashes[id]
      if (!h) throw new Error(`no pinned hash for fixture ${id}`)
      return [id, h]
    })),
    app_revision: app.revision,
    app_build: app.build,
    host,
  }
  return { key: `${task.id}-${sha256(canonicalJson(parts)).slice(0, 16)}`, parts }
}

/** The content hash fixtures.json pins for a fixture: the trimmed output's
 *  when it is trimmed, else the download's. */
export function pinnedFixtureHash(entry) {
  return entry.output_sha256 ?? entry.sha256
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
