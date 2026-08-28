// Per-workspace timeline view state persisted at <workspace>/view.json, owned by
// the Electron main process. The renderer (state/viewState.ts) is the only
// writer; it reads once per project and writes debounced. Best-effort UX, not a
// correctness anchor — a missing / empty / corrupt file degrades to defaults.
//
// Every field is read independently, serde `#[serde(default)]`-style, so the
// on-disk field set is NOT frozen: a field that changes name or shape costs a
// user the zoom level it held, never a project. That licence is what makes this
// file cheap to reshape, and it does not extend to project.json, which nothing
// here touches.
//
// Workspace-scoping is handled by the caller (ts-actor-host): pre-workspace it
// returns defaults on read and drops on write. This store always has a
// concrete workspace dir. The renderer prunes dead track ids before calling
// view_state_set.

import {
  DEFAULT_TIMELINE_PX_PER_SEC,
  viewStateDefaults,
  type CompositionTabView,
  type ViewState,
} from '../shared/view-state'

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface ViewStateFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface ViewStateStore {
  load(workspaceDir: string): ViewState
  save(workspaceDir: string, state: ViewState): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read the tab intent. An entry with no `composition_id` names no tab, so it
 *  is dropped rather than defaulted — every other field of a surviving entry
 *  falls back, because a tab worth reopening is worth reopening at the default
 *  zoom. */
function compositionTabsIn(value: unknown, fallback: CompositionTabView[]): CompositionTabView[] {
  if (!Array.isArray(value)) return fallback
  const tabs: CompositionTabView[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = entry.composition_id
    if (typeof id !== 'string' || id === '') continue
    tabs.push({
      composition_id: id,
      anchor_layer_id: typeof entry.anchor_layer_id === 'string' ? entry.anchor_layer_id : null,
      px_per_sec: finiteOr(entry.px_per_sec, DEFAULT_TIMELINE_PX_PER_SEC),
      scroll_left_px: finiteOr(entry.scroll_left_px, 0),
    })
  }
  return tabs
}

export function createViewStateStore(deps: { fs: ViewStateFs; join: (...parts: string[]) => string }): ViewStateStore {
  const fileOf = (ws: string) => deps.join(ws, 'view.json')
  return {
    load(ws) {
      const path = fileOf(ws)
      if (!deps.fs.exists(path)) return viewStateDefaults()
      let body: string
      try { body = deps.fs.readFile(path) }
      catch (e) { console.warn(`[view-state] read ${path}:`, e); return viewStateDefaults() }
      if (body.trim() === '') return viewStateDefaults()
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(body) as Record<string, unknown> }
      catch (e) { console.warn(`[view-state] parse ${path}:`, e); return viewStateDefaults() }
      // Per-field defaulting: a missing or wrong-typed field falls back to its
      // default, so an older file loads as far as it goes.
      const d = viewStateDefaults()
      const th = parsed.track_heights
      return {
        composition_tabs: compositionTabsIn(parsed.composition_tabs, d.composition_tabs),
        active_composition_id:
          typeof parsed.active_composition_id === 'string' ? parsed.active_composition_id : d.active_composition_id,
        track_heights: isRecord(th) ? (th as Record<string, number>) : d.track_heights,
        expanded_tracks: Array.isArray(parsed.expanded_tracks) ? parsed.expanded_tracks.filter((x): x is string => typeof x === 'string') : d.expanded_tracks,
      }
    },
    save(ws, state) {
      deps.fs.mkdirp(ws)
      const path = fileOf(ws)
      const tmp = path + '.tmp'
      deps.fs.writeFile(tmp, JSON.stringify(state, null, 2))
      deps.fs.rename(tmp, path) // atomic promote
    },
  }
}
