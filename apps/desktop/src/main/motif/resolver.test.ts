import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { motifErrorCode } from '../../shared/motifs/errors'
import { motifFrameCacheKey } from '../../renderer/render/motifs/motifFrames'
import { builtinMotifs, motifRevision } from './authoring'
import { normalize } from './motifPackage'
import { ProjectMotifStore } from './projectStore'
import { MotifGateRefusal, MotifResolver, routeOfHost } from './resolver'
import { PROPOSALS_DIR, UserMotifStore } from './store'
import { MotifTrust, TRUST_FILE, type MotifTrustView } from './trust'

const BUILTINS = builtinMotifs(path.resolve(__dirname, '../../shared/motifs/builtin'))

let root: string
let library: UserMotifStore
let resolver: MotifResolver
/** Revisions this machine does not trust; every other one is trusted. */
let untrusted: Set<string>
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'motif-resolver-'))
  library = new UserMotifStore(path.join(root, 'library'))
  untrusted = new Set()
  const trust: MotifTrustView = { trusted: revision => !untrusted.has(revision) }
  resolver = new MotifResolver(library, BUILTINS, trust)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const manifest = (id: string): Manifest => ({ id, name: id, version: 1, size: [320, 180], default_duration_s: 2, props_schema: {} })
const page = (id: string, body = 'motif.define({frame(t){}})') =>
  composeMotifHtml(manifest(id), `<html><head></head><body><script>${body}</script></body></html>`)

/** A project folder `name` under the test root, opened in the resolver. */
function openProject(name: string): ProjectMotifStore {
  const project = new ProjectMotifStore(path.join(root, name))
  resolver.setProject(project)
  return project
}
/** Writes `files` beside a page into `<project>/Motifs/<id>/`. */
function projectMotif(project: ProjectMotifStore, id: string, files: Record<string, string> = {}, body?: string): void {
  const dir = path.join(project.root(), id)
  mkdirSync(dir, { recursive: true })
  for (const [name, bytes] of Object.entries({ 'index.html': page(id, body), ...files })) writeFileSync(path.join(dir, name), bytes)
}
function install(id: string, files: Record<string, string> = {}): void {
  const all = [{ path: 'index.html', bytes: Buffer.from(page(id)) }, ...Object.entries(files).map(([p, b]) => ({ path: p, bytes: Buffer.from(b) }))]
  library.addVersion(id, 1, normalize(all, id, 1).files)
}
const text = (bytes: Buffer | null) => bytes?.toString('utf8') ?? null

describe('routing a host', () => {
  it('names the project by a bare id, the library and a proposal by their suffixes', () => {
    expect(routeOfHost('badge')).toEqual({ scope: 'project', id: 'badge' })
    expect(routeOfHost('badge--library')).toEqual({ scope: 'library', id: 'badge' })
    expect(routeOfHost('badge--proposal')).toEqual({ scope: 'proposal', id: 'badge' })
  })
})

describe('resolving a host', () => {
  it('serves a project Motif from the open project only', () => {
    expect(resolver.resolve('badge')).toMatchObject({ scope: 'project', status: 'missing', diagnostic: expect.stringMatching(/No project is open/) })
    const project = openProject('Film')
    expect(resolver.resolve('badge')).toMatchObject({ status: 'missing', diagnostic: expect.stringMatching(/no folder/) })
    // The Motif's state, not a capture failure: capture answers it without an error row.
    let refusal: unknown
    try { resolver.gate('badge') } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(MotifGateRefusal)
    expect(refusal).toMatchObject({ code: 'content', status: 'missing' })
    projectMotif(project, 'badge', { 'art.svg': '<svg/>' })
    expect(resolver.resolve('badge')).toEqual({ scope: 'project', id: 'badge', status: 'ok', revision: project.status('badge').revision,
      manifest: expect.objectContaining({ id: 'badge', size: [320, 180] }) })
    expect(text(resolver.readFile('badge', 'art.svg'))).toBe('<svg/>')
    resolver.setProject(null)
    expect(resolver.resolve('badge').status).toBe('missing')
    expect(resolver.readFile('badge', 'art.svg')).toBeNull()
  })

  it('refuses a Motif whose files make no package, and serves none of them', () => {
    const project = openProject('Film')
    projectMotif(project, 'broken', { 'manifest.json': '{ not json', 'art.svg': '<svg/>' })
    expect(resolver.resolve('broken')).toMatchObject({ status: 'invalid', revision: null, diagnostic: expect.any(String) })
    expect(resolver.readFile('broken', 'art.svg')).toBeNull()
    expect(() => resolver.gate('broken')).toThrow(expect.objectContaining({ code: 'content', status: 'invalid' }))
    expect(() => resolver.pin('broken', 'a'.repeat(64))).toThrow(expect.objectContaining({ code: 'content' }))
  })

  it('refuses a project Motif whose revision is not trusted here, keeping its manifest, and serves none of its files', () => {
    const project = openProject('Film')
    projectMotif(project, 'received', { 'params.html': '<html>p</html>', 'art.svg': '<svg/>' })
    const revision = project.status('received').revision!
    untrusted.add(revision)
    expect(resolver.resolve('received')).toEqual({ scope: 'project', id: 'received', status: 'untrusted', revision,
      manifest: expect.objectContaining({ id: 'received' }), diagnostic: expect.stringMatching(/not trusted on this machine/) })
    for (const file of ['index.html', 'params.html', 'art.svg']) expect(resolver.readFile('received', file), file).toBeNull()
    expect(() => resolver.gate('received')).toThrow(expect.objectContaining({ code: 'content', status: 'untrusted', message: expect.stringMatching(/not trusted/) }))
    expect(() => resolver.pin('received', revision)).toThrow(expect.objectContaining({ code: 'content' }))
    untrusted.delete(revision)
    expect(resolver.gate('received').revision).toBe(revision)
    resolver.pin('received', revision).release()
  })

  it('never asks about the library or a pending publication', () => {
    install('badge')
    untrusted.add(library.installedListing('badge')!.revision)
    expect(resolver.resolve('badge--library').status).toBe('ok')
    expect(resolver.readFile('badge--library', 'index.html')).not.toBeNull()
    const frozen = path.join(library.root(), PROPOSALS_DIR, 'card')
    mkdirSync(frozen, { recursive: true })
    writeFileSync(path.join(frozen, 'index.html'), page('card'))
    untrusted.add(resolver.resolve('card--proposal').revision!)
    expect(resolver.resolve('card--proposal').status).toBe('ok')
  })

  it('serves a library Motif from its current version, never the project copy of its id', () => {
    install('badge', { 'art.svg': 'library' })
    const project = openProject('Film')
    projectMotif(project, 'badge', { 'art.svg': 'project' })
    expect(resolver.resolve('badge--library')).toMatchObject({ scope: 'library', status: 'ok', revision: library.installedListing('badge')!.revision })
    expect(text(resolver.readFile('badge--library', 'art.svg'))).toBe('library')
    expect(text(resolver.readFile('badge', 'art.svg'))).toBe('project')
    expect(resolver.resolve('gone--library')).toMatchObject({ status: 'missing', diagnostic: expect.stringMatching(/not in the library/) })
  })

  it('serves a built-in from its library host with the bundled bytes, and its bare id only from the project', () => {
    const countdown = BUILTINS.find(b => b.id === 'countdown')!
    expect(resolver.resolve('countdown--library')).toMatchObject({ status: 'ok', revision: motifRevision(library, [...BUILTINS], 'countdown'), manifest: countdown.manifest })
    for (const file of countdown.files!) expect(resolver.readFile('countdown--library', file.path)).toEqual(file.bytes)
    expect(resolver.resolve('countdown').status).toBe('missing')
    const project = openProject('Film')
    expect(resolver.resolve('countdown').status).toBe('missing')
    expect(resolver.readFile('countdown', 'index.html')).toBeNull()
    projectMotif(project, 'countdown', {}, 'motif.define({frame(t){ /* edited */ }})')
    expect(text(resolver.readFile('countdown', 'index.html'))).toContain('edited')
    expect(text(resolver.readFile('countdown--library', 'index.html'))).not.toContain('edited')
  })

  it('serves a pending publication from its frozen package', () => {
    const frozen = path.join(library.root(), PROPOSALS_DIR, 'card')
    mkdirSync(frozen, { recursive: true })
    writeFileSync(path.join(frozen, 'index.html'), page('card'))
    expect(resolver.resolve('card--proposal')).toMatchObject({ scope: 'proposal', id: 'card', status: 'ok', manifest: expect.objectContaining({ id: 'card' }) })
    expect(text(resolver.readFile('card--proposal', 'index.html'))).toBe(page('card'))
    expect(resolver.resolve('other--proposal').status).toBe('missing')
  })

  it('lists the library hosts and the open project ids as served hosts', () => {
    install('badge')
    expect(resolver.hosts()).toEqual(expect.arrayContaining(['countdown--library', 'badge--library']))
    const project = openProject('Film')
    projectMotif(project, 'title')
    expect(resolver.hosts()).toContain('title')
    expect(resolver.hosts()).not.toContain('badge')
  })
})

describe('a project switch', () => {
  it('serves each project its own bytes of one id, a pinned revision included', () => {
    const a = openProject('A')
    projectMotif(a, 'badge', { 'art.svg': 'from A' })
    const revA = resolver.gate('badge').revision
    const pinA = resolver.pin('badge', revA)
    const b = openProject('B')
    projectMotif(b, 'badge', { 'art.svg': 'from B' })
    const revB = resolver.gate('badge').revision
    expect(revB).not.toBe(revA)
    expect(text(resolver.readFile('badge', 'art.svg'))).toBe('from B')
    const pinB = resolver.pin('badge', revB)
    // A host of A's revision still reads A's snapshot.
    expect(text(resolver.readFile('badge', `.revisions/${revA}/art.svg`))).toBe('from A')
    expect(text(resolver.readFile('badge', `.revisions/${revB}/art.svg`))).toBe('from B')
    resolver.setProject(a)
    expect(text(resolver.readFile('badge', 'art.svg'))).toBe('from A')
    expect(() => resolver.pin('badge', revB)).not.toThrow()
    pinA.release()
    pinB.release()
  })
})

describe('revision pins', () => {
  it('keeps a snapshot a host holds through later pins, and two that none hold', () => {
    const project = openProject('Film')
    const ids = ['a', 'b', 'c', 'd']
    const revision: Record<string, string> = {}
    for (const id of ids) {
      projectMotif(project, id)
      revision[id] = resolver.gate(id).revision
    }
    const served = (id: string) => resolver.readFile(id, `.revisions/${revision[id]}/index.html`) !== null
    // The first host is still loading its page when three more pin theirs.
    const first = resolver.pin('a', revision.a!)
    const later = ['b', 'c', 'd'].map(id => resolver.pin(id, revision[id]!))
    expect(served('a')).toBe(true)
    first.release()
    first.release()
    for (const pin of later) pin.release()
    // None held: the two pinned last stay for reuse.
    expect(ids.map(served)).toEqual([false, false, true, true])
  })

  it('refuses a revision the package no longer holds, and a host that is gone', () => {
    const project = openProject('Film')
    projectMotif(project, 'badge')
    expect(() => resolver.pin('badge', 'f'.repeat(64))).toThrow(/revision changed/)
    let error: unknown
    try { resolver.pin('gone', 'f'.repeat(64)) } catch (e) { error = e }
    expect(motifErrorCode(error)).toBe('content')
  })
})

describe('the frame cache key of project Motifs', () => {
  it('moves only for the Motif whose folder was edited', () => {
    const project = openProject('Film')
    projectMotif(project, 'a', { 'art.svg': 'one' })
    projectMotif(project, 'b', { 'art.svg': 'one' })
    const key = (host: string) => {
      const { manifest: m, revision } = resolver.gate(host)
      return motifFrameCacheKey({ motifId: m.id, version: m.version, contentHash: revision, canonicalProps: {},
        renderW: m.size[0], renderH: m.size[1], fpsNum: 30, fpsDen: 1, durationFrames: 60 })
    }
    const before = { a: key('a'), b: key('b') }
    writeFileSync(path.join(project.root(), 'a', 'art.svg'), 'two')
    expect(key('a')).not.toBe(before.a)
    expect(key('b')).toBe(before.b)
  })
})

describe('a trusted project folder', () => {
  const trustFile = () => path.join(root, 'library', TRUST_FILE)
  /** A resolver over the machine's trust record, hearing every revision a
   *  project sees as the app wires it, with project folder `name` open and a
   *  Motif received from another machine in it. */
  function received(name: string) {
    const trust = new MotifTrust(trustFile(), () => [])
    const trusting = new MotifResolver(library, BUILTINS, trust)
    trusting.onRevisionSeen((_id, revision, cause, base) => trust.seen(revision, cause, base))
    const project = new ProjectMotifStore(path.join(root, name))
    projectMotif(project, 'card', {}, 'motif.define({frame(t){ /* received */ }})')
    trusting.setProject(project)
    return { trust, resolver: trusting, project }
  }
  /** The revisions the record holds on disk. */
  const recorded = (trust: MotifTrust) => {
    trust.flush()
    return existsSync(trustFile()) ? Object.keys(JSON.parse(readFileSync(trustFile(), 'utf8')).revisions) : []
  }

  it('runs every Motif found in it at the open, recording no revision for them', () => {
    const { trust, resolver: trusting, project } = received('Film')
    const revision = project.status('card').revision!
    expect(trusting.resolve('card').status).toBe('untrusted')
    trust.trustProject()
    expect(trusting.projectFolderTrusted()).toBe(true)
    expect(trusting.resolve('card')).toMatchObject({ status: 'ok', revision })
    expect(trusting.gate('card').revision).toBe(revision)
    expect(trust.trusted(revision)).toBe(false)
    expect(recorded(trust)).toEqual([])
  })

  it('stops running a received Motif edited while trusted once the folder is untrusted, its revisions as they were', () => {
    const { trust, resolver: trusting, project } = received('Film')
    trust.trustProject()
    const before = recorded(trust)
    writeFileSync(path.join(project.root(), 'card', 'art.svg'), 'edited while trusted')
    // As the watcher hears the edit.
    project.observe('card')
    const edited = project.status('card').revision!
    expect(trusting.resolve('card')).toMatchObject({ status: 'ok', revision: edited })
    trust.untrustProject()
    expect(trusting.projectFolderTrusted()).toBe(false)
    expect(trusting.resolve('card')).toMatchObject({ status: 'untrusted', revision: edited })
    expect(recorded(trust)).toEqual(before)
  })

  it('trusts nothing in a project whose own folder is not trusted', () => {
    const { trust, resolver: trusting } = received('Film')
    const other = new ProjectMotifStore(path.join(root, 'Other'))
    projectMotif(other, 'card', {}, 'motif.define({frame(t){ /* other */ }})')
    trusting.setProject(other)
    trust.trustProject()
    expect(trusting.resolve('card').status).toBe('ok')
    trusting.setProject(new ProjectMotifStore(path.join(root, 'Film')))
    expect(trusting.projectFolderTrusted()).toBe(false)
    expect(trusting.resolve('card').status).toBe('untrusted')
  })
})
