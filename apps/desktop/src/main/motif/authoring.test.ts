import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore } from './store'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { builtinMotifs, motifToPayload, listMotifsInner, type BuiltinMotif } from './authoring'
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

describe('motifToPayload', () => {
  it('emits manifest fields + html + status, with the revision as content_hash', () => {
    const man = m('Foo', 'foo')
    const html = doc(man, 'FOO')
    const p = motifToPayload(man, html, 'installed', 'a-revision')
    expect(p.id).toBe('foo'); expect(p.name).toBe('Foo'); expect(p.status).toBe('installed')
    expect(p.html).toBe(html)
    expect(p.content_hash).toBe('a-revision')
  })
  it('stamps has_params_ui, defaulting to false', () => {
    const man = m('Foo', 'foo')
    const html = doc(man, 'FOO')
    expect(motifToPayload(man, html, 'installed', 'a-revision').has_params_ui).toBe(false)
    expect(motifToPayload(man, html, 'installed', 'a-revision', true).has_params_ui).toBe(true)
  })
})

describe('listMotifsInner', () => {
  it('isolates an unreadable package without dropping healthy entries', () => {
    store.addVersion('broken', 1, [{ path: 'index.html', bytes: Buffer.from(doc(m('Broken', 'broken'))) }])
    store.addVersion('healthy', 1, [{ path: 'index.html', bytes: Buffer.from(doc(m('Healthy', 'healthy'))) }])
    const listing = store.installedListing.bind(store)
    vi.spyOn(store, 'installedListing').mockImplementation(id => {
      if (id === 'broken') throw new Error('resource vanished during external save')
      return listing(id)
    })
    expect(listMotifsInner(store, BUILTINS).map(e => e.id)).toEqual(['countdown', 'healthy'])
  })
  it("an entry's content_hash covers its page, island included, and every companion's bytes", () => {
    const man = m('Foo', 'foo'), html = doc(man, 'FOO'), mesh = Buffer.from([0, 255, 17])
    store.addVersion('foo', 1, [{ path: 'index.html', bytes: Buffer.from(html) }])
    mkdirSync(path.join(root, 'foo', 'v1', 'assets'))
    writeFileSync(path.join(root, 'foo', 'v1', 'assets', 'mesh.bin'), mesh)
    const builtin = BUILTINS[0]!
    const list = listMotifsInner(store, BUILTINS)
    expect(list.find(e => e.id === 'foo')!.content_hash).toBe(motifContentHash(man, html, [{ path: 'assets/mesh.bin', bytes: mesh }]))
    expect(list.find(e => e.id === 'countdown')!.content_hash).toBe(motifContentHash(builtin.manifest, builtin.html))
  })
  it('lists builtins, then installed Motifs; an older release\'s drafts are not the library', () => {
    store.addVersion('foo', 1, [{ path: 'index.html', bytes: Buffer.from(doc(m('Foo', 'foo'))) }])
    mkdirSync(path.join(root, 'drafts', 'bar'), { recursive: true })
    writeFileSync(path.join(root, 'drafts', 'bar', 'index.html'), doc(m('Bar', 'bar')))
    const list = listMotifsInner(store, BUILTINS)
    expect(list.map(e => [e.id, e.status])).toEqual([['countdown', 'builtin'], ['foo', 'installed']])
    // every entry carries html + content_hash
    for (const e of list) { expect(typeof e.html).toBe('string'); expect(typeof e.content_hash).toBe('string') }
  })
  it('reports has_params_ui per entry for builtin and installed', () => {
    // built-in: carried on the BuiltinMotif (stat'd once at load).
    const builtins: BuiltinMotif[] = [{ ...BUILTINS[0]!, hasParamsUi: true }]
    // installed "foo" WITH a params page, installed "bare" without.
    store.addVersion('foo', 1, [{ path: 'index.html', bytes: Buffer.from(doc(m('Foo', 'foo'))) }])
    writeFileSync(path.join(root, 'foo', 'v1', 'params.html'), '<html>p</html>')
    store.addVersion('bare', 1, [{ path: 'index.html', bytes: Buffer.from(doc(m('Bare', 'bare'))) }])

    const list = listMotifsInner(store, builtins)
    const flag = (id: string) => list.find((e) => e.id === id)!.has_params_ui
    expect(flag('countdown')).toBe(true)
    expect(flag('foo')).toBe(true)
    expect(flag('bare')).toBe(false)
  })
  it('hot-updates has_params_ui when the file appears and vanishes', () => {
    store.addVersion('foo', 1, [{ path: 'index.html', bytes: Buffer.from(doc(m('Foo', 'foo'))) }])
    const flag = () => listMotifsInner(store, BUILTINS).find((e) => e.id === 'foo')!.has_params_ui
    expect(flag()).toBe(false)
    // The watcher re-runs this list on any disk change; nothing is cached.
    writeFileSync(path.join(root, 'foo', 'v1', 'params.html'), '<html>p</html>')
    expect(flag()).toBe(true)
    rmSync(path.join(root, 'foo', 'v1', 'params.html'))
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
      { layerId: 'la', motifId: 'wip', props: { old: 1 } },
      { layerId: 'lb', motifId: 'foo', props: { old: 2 } },
      { layerId: 'lc', motifId: 'other', props: {} }, // untouched
    ]
    const updates = buildRebindUpdates(layers, 'wip', target)
    expect(updates.length).toBe(2)
    for (const u of updates) {
      expect(u.motif_id).toBe('foo')
      expect(u.props.old).toBeUndefined()      // dropped (lenient)
      expect(u.props.title).toBe('Hi')         // filled default
    }
  })
})
