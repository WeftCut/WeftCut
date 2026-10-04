import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore } from './store'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { builtinMotifs, getMotifSource, motifToPayload, listMotifsInner, type BuiltinMotif } from './authoring'
import { motifContentHash } from './contentHash'


/** Minimal manifest factory. */
function m(name: string, id = 'ignored'): Manifest {
  return { id, name, version: 1, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} }
}
/** A composed full-source doc (island + body) for writing to disk. */
function doc(man: Manifest, body = 'x'): string {
  return composeMotifHtml(man, `<head></head><body>${body}<script>motif.define({setup(){}})</script></body>`)
}

let root: string
let store: UserMotifStore
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'motif-auth-')); store = new UserMotifStore(root) })

// A synthetic built-in (avoids depending on disk-relocated assets in this unit).
const BUILTINS: BuiltinMotif[] = [{ id: 'countdown', manifest: m('Countdown', 'countdown'), html: doc(m('Countdown', 'countdown'), 'CD'), hasParamsUi: false }]

describe('getMotifSource', () => {
  it('returns a built-in by id (built-in wins)', () => {
    const s = getMotifSource(store, BUILTINS, 'countdown')
    expect(s.manifest.id).toBe('countdown')
    expect(s.html).toContain('CD')
  })
  it('returns an installed user motif', () => {
    const man = m('Foo', 'foo')
    store.writeDraft('foo', doc(man, 'FOO')); store.installDraft('foo', 'foo')
    const s = getMotifSource(store, BUILTINS, 'foo')
    expect(s.manifest.id).toBe('foo'); expect(s.html).toContain('FOO')
  })
  it('throws on unknown id', () => {
    expect(() => getMotifSource(store, BUILTINS, 'nope')).toThrow(/unknown motif id/)
  })
})

describe('motifToPayload', () => {
  it('emits manifest fields + html + status + content_hash', () => {
    const man = m('Foo', 'foo')
    const html = doc(man, 'FOO')
    const p = motifToPayload(man, html, 'installed')
    expect(p.id).toBe('foo'); expect(p.name).toBe('Foo'); expect(p.status).toBe('installed')
    expect(p.html).toBe(html)
    expect(p.content_hash).toBe(motifContentHash(man, html)) // FULL html (island included)
  })
  it('stamps has_params_ui, defaulting to false', () => {
    const man = m('Foo', 'foo')
    const html = doc(man, 'FOO')
    expect(motifToPayload(man, html, 'installed').has_params_ui).toBe(false)
    expect(motifToPayload(man, html, 'installed', true).has_params_ui).toBe(true)
    // Presence is payload decoration only — it never enters the content hash.
    expect(motifToPayload(man, html, 'installed', true).content_hash)
      .toBe(motifToPayload(man, html, 'installed', false).content_hash)
  })
})

describe('listMotifsInner', () => {
  it('isolates an unreadable package without dropping healthy entries', () => {
    store.writeDraft('broken', doc(m('Broken', 'broken')))
    store.writeDraft('healthy', doc(m('Healthy', 'healthy')))
    const read = store.packageFiles.bind(store)
    vi.spyOn(store, 'packageFiles').mockImplementation(id => {
      if (id === 'broken') throw new Error('resource vanished during external save')
      return read(id)
    })
    expect(listMotifsInner(store, BUILTINS).map(e => e.id)).toEqual(['countdown', 'healthy'])
  })
  it('lists builtins, then installed, then drafts (id-unique, draft shadowed by published)', () => {
    // installed "foo"
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    // a separate draft "bar"
    store.writeDraft('bar', doc(m('Bar', 'bar')))
    const list = listMotifsInner(store, BUILTINS)
    const byId = (id: string) => list.find((e) => e.id === id)
    expect(byId('countdown')!.status).toBe('builtin')
    expect(byId('foo')!.status).toBe('installed')
    expect(byId('bar')!.status).toBe('draft')
    // every entry carries html + content_hash
    for (const e of list) { expect(typeof e.html).toBe('string'); expect(typeof e.content_hash).toBe('string') }
  })
  it('a draft sharing a published id is skipped (published wins)', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    store.writeDraft('foo', doc(m('Foo', 'foo'))) // a new draft re-using the published id
    const list = listMotifsInner(store, BUILTINS)
    expect(list.filter((e) => e.id === 'foo').length).toBe(1)
    expect(list.find((e) => e.id === 'foo')!.status).toBe('installed')
  })
  it('attaches target_id to a draft with a recorded Update target', () => {
    store.writeDraft('d1', doc(m('D1', 'd1'))); store.writeDraftTarget('d1', 'countdown')
    const list = listMotifsInner(store, BUILTINS)
    expect(list.find((e) => e.id === 'd1')!.target_id).toBe('countdown')
  })
  it('reports has_params_ui per entry for builtin, installed and draft', () => {
    // built-in: carried on the BuiltinMotif (stat'd once at load).
    const builtins: BuiltinMotif[] = [{ ...BUILTINS[0]!, hasParamsUi: true }]
    // installed "foo" WITH a params page, installed "bare" without.
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    writeFileSync(path.join(root, 'foo', 'params.html'), '<html>p</html>')
    store.writeDraft('bare', doc(m('Bare', 'bare'))); store.installDraft('bare', 'bare')
    // draft "d2" WITH a params page written next to its draft index.html.
    store.writeDraft('d2', doc(m('D2', 'd2')))
    writeFileSync(path.join(root, 'drafts', 'd2', 'params.html'), '<html>p</html>')

    const list = listMotifsInner(store, builtins)
    const flag = (id: string) => list.find((e) => e.id === id)!.has_params_ui
    expect(flag('countdown')).toBe(true)
    expect(flag('foo')).toBe(true)
    expect(flag('bare')).toBe(false)
    expect(flag('d2')).toBe(true)
  })
  it('hot-updates has_params_ui when the file appears and vanishes', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    const flag = () => listMotifsInner(store, BUILTINS).find((e) => e.id === 'foo')!.has_params_ui
    expect(flag()).toBe(false)
    // The watcher re-runs this list on any disk change; nothing is cached.
    writeFileSync(path.join(root, 'foo', 'params.html'), '<html>p</html>')
    expect(flag()).toBe(true)
    rmSync(path.join(root, 'foo', 'params.html'))
    expect(flag()).toBe(false)
  })
})

describe('builtinMotifs', () => {
  it('loads {id, manifest, html} for each on-disk built-in', () => {
    // Build a fake builtin dir with one motif.
    const bdir = mkdtempSync(path.join(tmpdir(), 'motif-builtins-'))
    mkdirSync(path.join(bdir, 'countdown'), { recursive: true })
    writeFileSync(path.join(bdir, 'countdown', 'index.html'), doc(m('Countdown', 'countdown'), 'CD'))
    const got = builtinMotifs(bdir)
    const cd = got.find((b) => b.id === 'countdown')
    expect(cd).toBeDefined()
    expect(cd!.manifest.id).toBe('countdown') // manifest comes from BUILTIN_MANIFESTS, not the disk island
    expect(cd!.html).toContain('CD')
    expect(cd!.hasParamsUi).toBe(false)
    rmSync(bdir, { recursive: true, force: true })
  })
  it('flags a built-in that ships params.html next to its index.html', () => {
    const bdir = mkdtempSync(path.join(tmpdir(), 'motif-builtins-'))
    mkdirSync(path.join(bdir, 'countdown'), { recursive: true })
    writeFileSync(path.join(bdir, 'countdown', 'index.html'), doc(m('Countdown', 'countdown'), 'CD'))
    writeFileSync(path.join(bdir, 'countdown', 'params.html'), '<html>params</html>')
    expect(builtinMotifs(bdir).find((b) => b.id === 'countdown')!.hasParamsUi).toBe(true)
    rmSync(bdir, { recursive: true, force: true })
  })
})

import {buildRebindUpdates,type MotifLayerRef} from './authoring'

describe('buildRebindUpdates', () => {
  it('retargets draft + target layers and lenient-migrates props', () => {
    const target: Manifest = {
      ...m('Foo', 'foo'), version: 2,
      props_schema: { title: { kind: 'String', default: 'Hi' } } as any,
    }
    const layers: MotifLayerRef[] = [
      { layerId: 'la', motifId: 'wip', version: 1, props: { old: 1 } },
      { layerId: 'lb', motifId: 'foo', version: 1, props: { old: 2 } },
      { layerId: 'lc', motifId: 'other', version: 1, props: {} }, // untouched
    ]
    const updates = buildRebindUpdates(layers, 'wip', target)
    expect(updates.length).toBe(2)
    for (const u of updates) {
      expect(u.motif_id).toBe('foo'); expect(u.motif_version).toBe(2)
      expect(u.props.old).toBeUndefined()      // dropped (lenient)
      expect(u.props.title).toBe('Hi')         // filled default
    }
  })
})
