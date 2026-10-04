import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore } from './store'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { runMotifTool, type MotifToolDeps } from './motifTools'
import type { BuiltinMotif, MotifLayerRef } from './authoring'


function m(name: string, id = 'ignored'): Manifest {
  return { id, name, version: 1, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} }
}
function doc(man: Manifest, body = 'x'): string {
  return composeMotifHtml(man, `<head></head><body>${body}<script>motif.define({setup(){}})</script></body>`)
}

let store: UserMotifStore
let emitted: number
let refreshed: number
let rebinds: unknown[][]
let layers: MotifLayerRef[]
let logs: string[]
let deps: MotifToolDeps
const BUILTINS: BuiltinMotif[] = [{ id: 'countdown', manifest: m('Countdown', 'countdown'), html: doc(m('Countdown', 'countdown'), 'CD'), hasParamsUi: false }]

beforeEach(() => {
  store = new UserMotifStore(mkdtempSync(path.join(tmpdir(), 'motiftools-')))
  emitted = 0; refreshed = 0; rebinds = []; layers = []; logs = []
  deps = {
    store, builtins: BUILTINS,
    motifLayers: () => layers,
    dispatchRebind: (u) => { rebinds.push(u) },
    emitChanged: () => { emitted++ },
    refreshCatalog: () => { refreshed++ },
    emitLog: (e) => { logs.push(e.message) },
  }
})

describe('project Motif staleness',()=>{
  it('motif_staleness_report returns [] when nothing is stale', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 2, props: {} }]
    expect(runMotifTool('motif_staleness_report', {}, deps)).toEqual([])
    expect(logs).toEqual([])
  })

  it('motif_staleness_report rows a v1 layer against a v2 published motif + logs a warn', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 1, props: { a: 1 } }]
    const report = runMotifTool('motif_staleness_report', {}, deps)
    expect(report).toEqual([{ motif_id: 'foo', name: 'Foo', placed_version: 1, current_version: 2, layer_count: 1 }])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('foo v1→v2')
  })

  it('acknowledge_motif_staleness dispatches a rebind for stale layers, returns the count, refreshes', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 1, props: { a: 1 } }]
    const count = runMotifTool('acknowledge_motif_staleness', {}, deps) as number
    expect(count).toBe(1)
    expect(rebinds.length).toBe(1)
    expect((rebinds[0] as any[])[0]).toMatchObject({ layer_id: 'la', motif_id: 'foo', motif_version: 2, props: { a: 1 } })
    expect(refreshed).toBe(1)
  })

  it('acknowledge_motif_staleness returns 0 + dispatches nothing when nothing is stale', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 2, props: {} }]
    expect(runMotifTool('acknowledge_motif_staleness', {}, deps)).toBe(0)
    expect(rebinds).toEqual([])
    expect(refreshed).toBe(1)   // refresh is unconditional (cheap, idempotent)
  })
})
