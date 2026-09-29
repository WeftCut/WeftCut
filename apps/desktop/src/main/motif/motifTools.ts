// apps/desktop/src/main/motif/motifTools.ts
//
// Host-level Motif tool dispatcher. Both surfaces call this: the renderer IPC
// path (ts-actor-host.handleInvoke `case 'motif'`) and the MCP path (server.ts
// `route === 'motif'`). Returns a RAW value (array | object | id string | null);
// the MCP caller wraps it via shapeMotifMcpResult, the renderer returns it as-is.
import type { Manifest } from '../../shared/motifs/catalog'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { encodeMotifZip, readMotifZip } from './archive'
import type { MotifRebindEntry } from '../state/model'
import type { UserMotifStore } from './store'
import {
  type BuiltinMotif, type MotifLayerRef, type InstallArgs,
  getMotifSource, listMotifsInner, writeMotifDraftCore, amendDraftHtml,
  createEditDraftCore, importMotifPackage, motifSourceFiles, deleteMotifCore, installMotifCompute,
} from './authoring'
import { type MotifStaleEntry, currentVersions, buildStalenessReport, buildAckEntries } from './staleness'

export interface MotifToolDeps {
  store: UserMotifStore
  builtins: BuiltinMotif[]
  /** Motif layers from the live actor snapshot (install Update rebind input). */
  motifLayers: () => MotifLayerRef[]
  /** Apply rebind_motif through the actor; throws on a rejected write. */
  dispatchRebind: (updates: MotifRebindEntry[]) => void
  /** Emit `motifs:changed` to the renderer (picker re-pull + host buster). */
  emitChanged: () => void
  /** Re-pull list_motifs → actor.setUserMotifManifests (content-window clamp). */
  refreshCatalog: () => void
  /** Emit a record-panel LogBus warn row (the on-open staleness summary).
   *  Best-effort; the host wraps the underlying emit in try/catch. */
  emitLog: (entry: { level: 'warn'; category: { kind: 'Project' }; source: { kind: 'System' }; message: string }) => void
}

/** Coerce the install `mode` arg. The renderer sends the object form
 *  `{ kind, target_id? }`; the MCP schema advertises a bare string "new"/"update"
 *  plus an optional `target_id`. A bare "update" resolves its target from the
 *  explicit `target_id`, else from the target the draft RECORDED at
 *  `write_motif_draft { from }`; neither present is refused naming both ways to
 *  supply one, before anything is written. */
function parseMode(mode: unknown, targetId: unknown, draftId: string, store: UserMotifStore): InstallArgs['mode'] {
  if (typeof mode === 'string' && mode !== 'new' && mode !== 'update')
    throw new Error(`install_motif mode '${mode}' is neither 'new' nor 'update'`)
  if (mode === 'new') return { kind: 'new' }
  if (mode === 'update') {
    const explicit = typeof targetId === 'string' && targetId.trim() !== '' ? targetId.trim() : null
    const target = explicit ?? store.readDraftTarget(draftId)
    if (target === null) {
      throw new Error(`install_motif { mode: "update" } needs a target, and draft '${draftId}' records none: pass target_id (an installed Motif's id — list_motifs reports them), write the draft with write_motif_draft { from } so it records one, or install it as mode "new"`)
    }
    return { kind: 'update', target_id: target }
  }
  return mode as InstallArgs['mode']
}

export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps): unknown {
  // Renderer write/install nest under `args`; everything else is flat. MCP is flat.
  const a = (rawArgs.args ?? rawArgs) as Record<string, unknown>
  switch (name) {
    case 'list_motifs':
      return listMotifsInner(deps.store, deps.builtins)
    case 'get_motif_source':
      return getMotifSource(deps.store, deps.builtins, a.id as string)
    case 'write_motif_draft': {
      const from = (a.from as string | undefined) ?? null
      const files = from ? motifSourceFiles(deps.store, deps.builtins, from) : []
      const id = writeMotifDraftCore(deps.store, a.manifest as Manifest, a.html as string, from, files)
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'amend_motif_draft': {
      // Renderer arg shape: { draftId, source } (camelCase, flat).
      amendDraftHtml(deps.store, a.draftId as string, a.source as string)
      deps.emitChanged(); deps.refreshCatalog()
      return null
    }
    case 'create_edit_draft': {
      const id = createEditDraftCore(deps.store, deps.builtins, a.sourceId as string)
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'import_motif': {
      if (a.directory === true || typeof a.path !== 'string' || path.extname(a.path).toLowerCase() !== '.zip') {
        throw new Error('Import Motif accepts only .zip packages. Package index.html and its resources in a ZIP first.')
      }
      const id = importMotifPackage(deps.store, readMotifZip(a.path))
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'export_motif': {
      const id = a.id as string
      const source = getMotifSource(deps.store, deps.builtins, id)
      const files = motifSourceFiles(deps.store, deps.builtins, id)
      const bytes = encodeMotifZip(id, [
        { path: 'index.html', bytes: Buffer.from(source.html) },
        ...files.filter(f => f.path !== 'index.html'),
      ])
      writeFileSync(a.path as string, bytes)
      return null
    }
    case 'delete_motif': {
      deleteMotifCore(deps.store, a.id as string)
      deps.emitChanged(); deps.refreshCatalog()
      return null
    }
    case 'install_motif': {
      const draftId = a.draft_id as string
      const args: InstallArgs = { draft_id: draftId, mode: parseMode(a.mode, a.target_id, draftId, deps.store) }
      const { publishedId, updates } = installMotifCompute(deps.store, deps.motifLayers(), args)
      if (updates.length) deps.dispatchRebind(updates)
      deps.emitChanged(); deps.refreshCatalog()
      return publishedId
    }
    case 'motif_staleness_report': {
      const current = currentVersions(deps.builtins, deps.store.listManifests())
      const layers = deps.motifLayers().map((l) => ({ motifId: l.motifId, placedVersion: l.version }))
      const report: MotifStaleEntry[] = buildStalenessReport(layers, current)
      if (report.length) {
        const summary = report
          .map((e) => `${e.motif_id} v${e.placed_version}→v${e.current_version} (${e.layer_count} layer(s))`)
          .join(', ')
        deps.emitLog({ level: 'warn', category: { kind: 'Project' }, source: { kind: 'System' }, message: `Motifs changed since placement: ${summary}` })
      }
      return report
    }
    case 'acknowledge_motif_staleness': {
      const current = currentVersions(deps.builtins, deps.store.listManifests())
      const layers = deps.motifLayers().map((l) => ({ layerId: l.layerId, motifId: l.motifId, placedVersion: l.version, props: l.props }))
      const updates = buildAckEntries(layers, current)
      if (updates.length) deps.dispatchRebind(updates)
      // Refresh so applyUpdateLayerParams' content-window clamp sees the
      // current manifests. Cheap + idempotent.
      deps.refreshCatalog()
      return updates.length
    }
    default:
      throw new Error(`runMotifTool: unhandled tool ${name}`)
  }
}
