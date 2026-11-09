// apps/desktop/src/main/motif/workspace.publication.test.ts
//
// ADR 0046's gate, enforced: an agent's `install_motif` proposes; only the
// user's approval in the Motif panel publishes. Pinned here: a proposal does
// not touch the library; approval publishes the frozen revision and rebinds
// the trial layers (naming dropped props); rejection keeps the draft with the
// note; a newer proposal supersedes the older; a taken id refuses with the
// ways forward, never numbered; pending proposals survive a restart.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore, proposalPreviewId } from './store'
import { MotifWorkspace } from './workspace'
import { runMotifTool, type MotifToolDeps } from './motifTools'
import type { MotifLayerRef } from './authoring'
import { MotifRefusal } from './refusal'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'

const roots: string[] = []
function temp() { const root = mkdtempSync(path.join(tmpdir(), 'motif-publication-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function world(builtins: Array<{ id: string; manifest: Manifest; html: string; hasParamsUi: boolean }> = []) {
  const root = temp()
  const store = new UserMotifStore(root)
  let layers: MotifLayerRef[] = []
  const rebinds: unknown[][] = []
  let changed = 0, notified = 0
  const deps = (): MotifToolDeps => ({
    store, builtins, motifLayers: () => layers, dispatchRebind: (u) => { rebinds.push(u) },
    emitChanged: () => { changed++ }, refreshCatalog: () => {}, emitLog: () => {}, notifyAgents: () => { notified++ },
  })
  const call = (name: string, args: Record<string, unknown> = {}) => runMotifTool(name, args, deps()) as any
  return {
    root, store, call, rebinds,
    setLayers: (l: MotifLayerRef[]) => { layers = l },
    counts: () => ({ changed, notified }),
    // A second workspace over the same store: the app after a restart.
    restarted: () => new MotifWorkspace(new UserMotifStore(root), builtins as never),
  }
}

/** An app-owned draft named `name` with a `title` prop. */
function draft(w: ReturnType<typeof world>, name: string, body = 'one', schema: Record<string, unknown> = { title: { type: 'string', default: 'Hi' } }) {
  const opened = w.call('open_motif_draft', { source: { kind: 'empty', name } })
  return w.call('update_motif_files', { motif_id: opened.motif_id, expected_revision: opened.revision, files: [
    { path: 'manifest.json', text: JSON.stringify({ name, size: [64, 64], default_duration_s: 1, props_schema: schema }) },
    { path: 'index.html', text: `<html><body>${body}</body></html>` },
  ] }) as { motif_id: string; revision: string }
}
const installedIds = (w: ReturnType<typeof world>) => w.store.listManifests().map((m) => m.id)

describe('install_motif proposes; the library waits for the user', () => {
  it('a proposal leaves the library untouched and answers awaiting_approval with the new id', () => {
    const w = world()
    const d = draft(w, 'Name strap')
    // The draft's id is not the name's: the name's id stays free to publish.
    expect(d.motif_id).toBe('name-strap-draft')
    const answer = w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    expect(answer).toMatchObject({ state: 'awaiting_approval', revision: d.revision, target: { new_id: 'name-strap' } })
    expect(typeof answer.proposal_id).toBe('string')
    expect(installedIds(w)).toEqual([])
    expect(w.rebinds).toEqual([])
    const row = w.call('list_motifs', { status: 'draft' })[0]
    expect(row.publication).toMatchObject({ state: 'awaiting_approval', proposal_id: answer.proposal_id })
    // Agents hear of it: the renderer's card and MCP's list_changed.
    expect(w.counts().notified).toBe(1)
  })

  it('approval publishes the frozen revision, not a later edit, and rebinds the trial layers naming dropped props', () => {
    const w = world()
    const d = draft(w, 'Name strap', 'proposed')
    const p = w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    // The agent keeps editing after proposing; approval still publishes what was proposed.
    w.call('update_motif_files', { motif_id: d.motif_id, expected_revision: d.revision, files: [{ path: 'index.html', text: '<html><body>later</body></html>' }] })
    expect(w.store.readHtml(proposalPreviewId(d.motif_id))).toContain('proposed')
    w.setLayers([{ layerId: 'L1', motifId: d.motif_id, version: 1, props: { title: 'Ada', stale: 1 } }, { layerId: 'L2', motifId: 'other', version: 1, props: {} }])
    expect(w.call('list_motif_proposals')[0]).toMatchObject({ motif_id: d.motif_id, preview_id: proposalPreviewId(d.motif_id), diff: null, rebinds: ['L1'] })
    const approved = w.call('approve_motif_proposal', { motif_id: d.motif_id, proposal_id: p.proposal_id })
    expect(approved.motif_id).toBe('name-strap')
    expect(approved.publication).toMatchObject({ state: 'approved', version: 1, rebound: [{ layer_id: 'L1', dropped_props: ['stale'] }] })
    expect(w.store.readHtml('name-strap')).toContain('proposed')
    expect(w.rebinds).toEqual([[expect.objectContaining({ layer_id: 'L1', motif_id: 'name-strap', motif_version: 1 })]])
    expect(w.call('list_motifs', { status: 'draft' })[0].publication).toMatchObject({ state: 'approved', version: 1, rebound: [{ layer_id: 'L1', dropped_props: ['stale'] }] })
    expect(w.call('list_motif_proposals')).toEqual([])
    // A proposal is decided once.
    expect(() => w.call('approve_motif_proposal', { motif_id: d.motif_id, proposal_id: p.proposal_id })).toThrow(/already approved/)
  })

  it('rejection keeps the draft, stores the note and touches no library entry', () => {
    const w = world()
    const d = draft(w, 'Card')
    const p = w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    const rejected = w.call('reject_motif_proposal', { motif_id: d.motif_id, proposal_id: p.proposal_id, note: '  bigger title  ' })
    expect(rejected).toMatchObject({ state: 'rejected', note: 'bigger title' })
    expect(installedIds(w)).toEqual([])
    expect(w.store.getDraft(d.motif_id)).not.toBeNull()
    expect(w.store.getMotif(proposalPreviewId(d.motif_id))).toBeNull()
    expect(w.call('read_motif', { motif_id: d.motif_id }).publication).toMatchObject({ state: 'rejected', note: 'bigger title' })
  })

  it('a newer proposal from the same draft supersedes the older; the same one again is the same proposal', () => {
    const w = world()
    const d = draft(w, 'Card')
    const first = w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    expect(w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision }).proposal_id).toBe(first.proposal_id)
    const edited = w.call('update_motif_files', { motif_id: d.motif_id, expected_revision: d.revision, files: [{ path: 'index.html', text: '<html><body>two</body></html>' }] })
    const second = w.call('install_motif', { motif_id: d.motif_id, expected_revision: edited.revision })
    expect(second.proposal_id).not.toBe(first.proposal_id)
    expect(second.superseded_proposal_id).toBe(first.proposal_id)
    expect(w.call('list_motif_proposals').map((c: { proposal_id: string }) => c.proposal_id)).toEqual([second.proposal_id])
    expect(() => w.call('approve_motif_proposal', { motif_id: d.motif_id, proposal_id: first.proposal_id })).toThrow(/superseded/)
    expect(w.store.readHtml(proposalPreviewId(d.motif_id))).toContain('two')
  })

  it('a taken id refuses MotifIdTaken with the options, and is never numbered', () => {
    const w = world([{ id: 'lower-third', manifest: { id: 'lower-third', name: 'Lower third', version: 1, size: [64, 64], default_duration_s: 1, fonts: [], props_schema: {} } as Manifest, html: composeMotifHtml({ id: 'lower-third', name: 'Lower third', version: 1, size: [64, 64], default_duration_s: 1, fonts: [], props_schema: {} } as Manifest, '<body>b</body>'), hasParamsUi: false }])
    const first = draft(w, 'Badge')
    w.call('approve_motif_proposal', { motif_id: first.motif_id, proposal_id: w.call('install_motif', { motif_id: first.motif_id, expected_revision: first.revision }).proposal_id })
    // A second draft with the same name: H3's "-2" is refused, with both ways forward.
    const second = draft(w, 'Badge', 'other')
    let refusal: MotifRefusal | undefined
    try { w.call('install_motif', { motif_id: second.motif_id, expected_revision: second.revision }) } catch (e) { refusal = e as MotifRefusal }
    expect(refusal).toBeInstanceOf(MotifRefusal)
    expect(refusal!.data).toMatchObject({ error: 'MotifIdTaken', id: 'badge', holder: 'installed' })
    expect(refusal!.data.options).toEqual(["rename the draft's manifest name (the new id is made from it)", "replace with target_id 'badge' + expected_version 1"])
    expect(installedIds(w)).toEqual(['badge'])
    // The replace option works, and the card diffs against version 1.
    const replace = w.call('install_motif', { motif_id: second.motif_id, expected_revision: second.revision, target_id: 'badge', expected_version: 1 })
    expect(replace.target).toEqual({ id: 'badge', version: 1 })
    expect(w.call('list_motif_proposals')[0].diff).toEqual({ files: { added: [], removed: [], changed: ['index.html'] }, props: { added: [], removed: [], changed: [] } })
    // A copy of a built-in under its own name: rename only.
    const copy = w.call('open_motif_draft', { source: { kind: 'motif', motif_id: 'lower-third' } })
    expect(copy.source).toEqual({ id: 'lower-third', version: 1 })
    expect(() => w.call('install_motif', { motif_id: copy.motif_id, expected_revision: copy.revision })).toThrow(/taken by a built-in Motif/)
  })

  it('a stale expected_revision carries current_revision', () => {
    const w = world()
    const d = draft(w, 'Card')
    let refusal: MotifRefusal | undefined
    try { w.call('install_motif', { motif_id: d.motif_id, expected_revision: 'stale' }) } catch (e) { refusal = e as MotifRefusal }
    expect(refusal!.data).toEqual({ error: 'RevisionConflict', current_revision: d.revision })
    expect(() => w.call('update_motif_files', { motif_id: d.motif_id, expected_revision: 'stale', files: [{ path: 'a.txt', text: 'a' }] })).toThrow(new RegExp(d.revision))
  })

  it('a pending proposal survives a restart and is approved there', () => {
    const w = world()
    const d = draft(w, 'Card')
    const p = w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    const after = w.restarted()
    expect(after.proposals().map((c) => c.proposal_id)).toEqual([p.proposal_id])
    expect(after.approve(d.motif_id, p.proposal_id).motif_id).toBe('card')
    expect(installedIds(w)).toEqual(['card'])
  })

  it('an update proposal refuses approval once the target moved on', () => {
    const w = world()
    const d = draft(w, 'Card')
    w.call('approve_motif_proposal', { motif_id: d.motif_id, proposal_id: w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision }).proposal_id })
    const next = w.call('update_motif_files', { motif_id: d.motif_id, expected_revision: d.revision, files: [{ path: 'index.html', text: '<html><body>v2</body></html>' }] })
    const p = w.call('install_motif', { motif_id: d.motif_id, expected_revision: next.revision })
    expect(p.target).toEqual({ id: 'card', version: 1 })
    // The user publishes another draft over it in the app meanwhile.
    const other = draft(w, 'Other')
    w.call('publish_motif', { motif_id: other.motif_id, expected_revision: other.revision, target_id: 'card', expected_version: 1 })
    expect(() => w.call('approve_motif_proposal', { motif_id: d.motif_id, proposal_id: p.proposal_id })).toThrow(/changed since this proposal/)
  })

  it('deleting the draft drops its proposal', () => {
    const w = world()
    const d = draft(w, 'Card')
    w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    w.call('delete_motif', { motif_id: d.motif_id })
    expect(w.call('list_motif_proposals')).toEqual([])
    expect(w.store.getMotif(proposalPreviewId(d.motif_id))).toBeNull()
  })

  it('an invalid linked draft cannot be proposed', () => {
    const w = world()
    const dir = temp()
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Linked', size: [64, 64], default_duration_s: 1, props_schema: {} }))
    writeFileSync(path.join(dir, 'index.html'), '<html>x</html>')
    const d = w.call('open_motif_draft', { source: { kind: 'directory', path: dir } })
    writeFileSync(path.join(dir, 'manifest.json'), '{broken')
    expect(() => w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })).toThrow(/invalid/)
  })
})

describe('the proposal preview id', () => {
  it('serves the frozen package to the preview player, and no tool reads or deletes through it', () => {
    const w = world()
    const d = draft(w, 'Card')
    w.call('install_motif', { motif_id: d.motif_id, expected_revision: d.revision })
    const id = proposalPreviewId(d.motif_id)
    expect(w.store.getMotif(id)).not.toBeNull()
    expect(w.store.pinPackage(id, d.revision)).not.toBeNull()
    expect(() => w.call('read_motif', { motif_id: id })).toThrow(/Invalid Motif id/)
    expect(() => w.call('delete_motif', { motif_id: id })).toThrow(/Invalid Motif id/)
  })
})

describe('a draft from before draft ids carried -draft', () => {
  /** A released build's draft: its id is its name's, `card`. */
  function legacyDraft(w: ReturnType<typeof world>, directory?: string) {
    const manifest = { id: 'card', name: 'Card', version: 1, size: [64, 64], default_duration_s: 1, fonts: [], props_schema: { title: { type: 'string', default: 'Hi' } } } as Manifest
    w.store.writeDraft('card', composeMotifHtml(manifest, '<body>legacy</body>'))
    if (directory) {
      mkdirSync(path.join(w.root, '.workspaces'), { recursive: true })
      writeFileSync(path.join(w.root, '.workspaces', 'card.json'), JSON.stringify({ directory: realpathSync.native(directory) }))
    }
    return w.call('read_motif', { motif_id: 'card' }) as { revision: string }
  }

  it('publishes under its own id without the user doing anything: approval moves the draft to <id>-draft and rebinds the trial layer', () => {
    const w = world()
    const dir = temp()
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Card', size: [64, 64], default_duration_s: 1, props_schema: { title: { type: 'string', default: 'Hi' } } }))
    writeFileSync(path.join(dir, 'index.html'), '<html><body>linked</body></html>')
    const before = legacyDraft(w, dir)
    // Its own id is not a collision for its own proposal.
    const p = w.call('install_motif', { motif_id: 'card', expected_revision: before.revision })
    expect(p).toMatchObject({ state: 'awaiting_approval', target: { new_id: 'card' } })
    w.setLayers([{ layerId: 'L1', motifId: 'card', version: 1, props: { title: 'Ada' } }])
    expect(w.call('list_motif_proposals')[0].rebinds).toEqual(['L1'])
    const approved = w.call('approve_motif_proposal', { motif_id: 'card', proposal_id: p.proposal_id })
    expect(approved.motif_id).toBe('card')
    expect(approved.publication).toMatchObject({ state: 'approved', version: 1, renamed_draft: { from: 'card', to: 'card-draft' } })
    expect(installedIds(w)).toEqual(['card'])
    expect(w.store.readHtml('card')).toContain('linked')
    // The draft lives on as card-draft, still linked to the same folder, with the outcome.
    const draftRow = w.call('read_motif', { motif_id: 'card-draft' })
    expect(draftRow).toMatchObject({ status: 'draft', directory: realpathSync.native(dir), publication: { state: 'approved', renamed_draft: { from: 'card', to: 'card-draft' } }, target_id: 'card' })
    expect(w.call('list_motifs', { status: 'draft' }).map((m: { id: string }) => m.id)).toEqual(['card-draft'])
    expect(w.call('read_motif', { motif_id: 'card' }).status).toBe('installed')
    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('linked')
    expect(w.rebinds).toEqual([[expect.objectContaining({ layer_id: 'L1', motif_id: 'card', motif_version: 1, props: { title: 'Ada' } })]])
    // The moved draft keeps following its folder, and its next proposal updates the publication.
    writeFileSync(path.join(dir, 'index.html'), '<html><body>v2</body></html>')
    const next = w.call('read_motif', { motif_id: 'card-draft' })
    expect(w.call('install_motif', { motif_id: 'card-draft', expected_revision: next.revision }).target).toEqual({ id: 'card', version: 1 })
  })

  it('refuses DraftIdTaken, changing nothing, when <id>-draft is held', () => {
    const w = world()
    const before = legacyDraft(w)
    const other = draft(w, 'Card')
    expect(other.motif_id).toBe('card-draft')
    const p = w.call('install_motif', { motif_id: 'card', expected_revision: before.revision })
    let refusal: MotifRefusal | undefined
    try { w.call('approve_motif_proposal', { motif_id: 'card', proposal_id: p.proposal_id }) } catch (e) { refusal = e as MotifRefusal }
    expect(refusal).toBeInstanceOf(MotifRefusal)
    expect(refusal!.data).toEqual({ error: 'DraftIdTaken', id: 'card-draft', holder: 'draft' })
    expect(refusal!.message).toContain("the draft 'card-draft'")
    expect(installedIds(w)).toEqual([])
    expect(w.store.getDraft('card')).not.toBeNull()
    expect(w.call('list_motif_proposals').map((c: { proposal_id: string }) => c.proposal_id)).toEqual([p.proposal_id])
  })
})
