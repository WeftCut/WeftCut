import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UserMotifStore } from './store';
import { MotifWorkspace } from './workspace';
import { runMotifTool } from './motifTools';
import { createHash } from 'node:crypto';
const roots: string[] = [];
function temp() { const root = mkdtempSync(path.join(tmpdir(), 'motif-workspace-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
const manifest = { name: 'Workspace', size: [64, 64], default_duration_s: 1, props_schema: {} };
function folder() {
    const root = temp();
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(root, 'index.html'), '<html><body>one</body></html>');
    return root;
}
it('reopens a linked directory as the same draft, captures edits and never deletes the source', () => {
    const store = new UserMotifStore(temp());
    const workspace = new MotifWorkspace(store, []);
    const directory = folder();
    const first = workspace.open({ kind: 'directory', path: directory });
    expect(workspace.open({ kind: 'directory', path: directory }).draft_id).toBe(first.draft_id);
    writeFileSync(path.join(directory, 'index.html'), '<html><body>two</body></html>');
    const next = workspace.read(first.draft_id);
    expect(next.revision).not.toBe(first.revision);
    expect(store.readHtml(first.draft_id)).toContain('two');
    workspace.delete(first.draft_id);
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toContain('two');
});
it('updates several files together, refuses stale revisions, and publishes a retained draft exactly once', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []);
    const draft = workspace.open({ kind: 'directory', path: folder() });
    const next = workspace.update(draft.draft_id, draft.revision, [{ path: 'scene.js', text: 'export const color="red"' }, { path: 'index.html', text: '<html>new</html>' }]);
    expect(() => workspace.update(draft.draft_id, draft.revision, [{ path: 'scene.js', delete: true }])).toThrow(/revision/i);
    expect(() => workspace.update(draft.draft_id, next.revision, [{ path: 'index.html', delete: true }, { path: 'scene.js', delete: true }])).toThrow(/index.html/);
    expect(store.readFile(draft.draft_id, 'scene.js')).not.toBeNull();
    const published = workspace.install(draft.draft_id, next.revision);
    expect(published.motif_id).not.toBe(draft.draft_id);
    expect(store.getDraft(draft.draft_id)).not.toBeNull();
    expect(workspace.install(draft.draft_id, next.revision)).toEqual(published);
    workspace.update(draft.draft_id, next.revision, [{ path: 'scene.js', text: 'blue' }]);
    expect(store.readFile(published.motif_id, 'scene.js')?.toString()).toContain('red');
});
it('uploads, edits, reads and exports binary companions through public tools without filesystem access', () => {
    const store = new UserMotifStore(temp());
    const call = (name: string, args: Record<string, unknown> = {}) => runMotifTool(name, args, { store, builtins: [], motifLayers: () => [], dispatchRebind: () => { }, emitChanged: () => { }, refreshCatalog: () => { }, emitLog: () => { } }) as any;
    const draft = call('open_motif_draft', { source: { kind: 'empty', name: 'Files' } });
    const bytes = Buffer.from([0, 255, 1]), sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = call('begin_file_upload', { size: bytes.length, sha256 });
    call('write_file_chunk', { file_id: upload.file_id, offset: 0, base64: bytes.toString('base64') });
    const edited = call('update_motif_files', { draft_id: draft.draft_id, expected_revision: draft.revision, files: [{ path: 'assets/model.glb', file_id: upload.file_id }, { path: 'scene.js', text: 'hello' }] });
    call('delete_file_transfer', { file_id: upload.file_id });
    const info = call('read_motif', { id: draft.draft_id });
    expect(info.html).toBeUndefined();
    const file = call('read_motif', { id: draft.draft_id, path: 'assets/model.glb' });
    expect(call('read_file_transfer', { file_id: file.file_id }).base64).toBe(bytes.toString('base64'));
    const zip = call('export_motif', { id: draft.draft_id, expected_revision: edited.revision });
    const imported = call('open_motif_draft', { source: { kind: 'zip', file_id: zip.file_id } });
    expect(store.readFile(imported.draft_id, 'assets/model.glb')).toEqual(bytes);
    call('update_motif_files', { draft_id: draft.draft_id, expected_revision: edited.revision, files: [{ path: 'scene.js', text: 'replaced' }, { path: 'assets/model.glb', delete: true }] });
    expect(store.readFile(draft.draft_id, 'assets/model.glb')).toBeNull();
    for (const name of ['write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'get_motif_source'])
        expect(() => call(name, {})).toThrow(/unhandled/);
});
it('reports invalid linked edits without losing the draft, blocks publication and recovers after repair', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []), directory = folder();
    const draft = workspace.open({ kind: 'directory', path: directory });
    writeFileSync(path.join(directory, 'manifest.json'), '{broken');
    expect(workspace.read(draft.draft_id).diagnostic).toBeTruthy();
    expect(workspace.list('draft')).toHaveLength(1);
    expect(() => store.assertRenderable(draft.draft_id)).toThrow(/invalid/);
    expect(() => workspace.install(draft.draft_id, draft.revision)).toThrow(/invalid/);
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(workspace.read(draft.draft_id).diagnostic).toBeUndefined();
    expect(workspace.install(draft.draft_id, draft.revision).version).toBe(1);
});
it('refuses escaping paths, path collisions and directory junctions before modifying files', () => {
    const workspace = new MotifWorkspace(new UserMotifStore(temp()), []), directory = folder();
    const draft = workspace.open({ kind: 'directory', path: directory });
    for (const name of ['../escape', 'C:/escape', 'target', 'a\\b'])
        expect(() => workspace.update(draft.draft_id, draft.revision, [{ path: name, text: 'bad' }])).toThrow();
    expect(() => workspace.update(draft.draft_id, draft.revision, [{ path: 'Asset/a', text: 'x' }, { path: 'asset/b', text: 'x' }])).toThrow(/Conflicting/);
    const outside = temp();
    mkdirSync(path.join(outside, 'assets'));
    symlinkSync(outside, path.join(directory, 'linked'), 'junction');
    expect(workspace.read(draft.draft_id).diagnostic).toMatch(/symbolic/);
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toContain('one');
    rmSync(path.join(directory, 'linked'));
});
it('keeps a capture navigation on the same resource bytes while the directory advances', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []), directory = folder();
    writeFileSync(path.join(directory, 'scene.js'), 'old');
    const draft = workspace.open({ kind: 'directory', path: directory });
    expect(store.pinPackage(draft.draft_id, draft.revision)).toBe(true);
    writeFileSync(path.join(directory, 'scene.js'), 'new');
    const next = workspace.read(draft.draft_id);
    expect(next.revision).not.toBe(draft.revision);
    expect(store.readFile(draft.draft_id, `.revisions/${draft.revision}/scene.js`)?.toString()).toBe('old');
    expect(store.readFile(draft.draft_id, 'scene.js')?.toString()).toBe('new');
});
it('requires an explicit target version and rejects a second editor overwriting a newer publication', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []);
    const draft = workspace.open({ kind: 'empty', name: 'Original' }), pub = workspace.install(draft.draft_id, draft.revision);
    const copy = workspace.open({ kind: 'motif', id: pub.motif_id });
    expect(store.readDraftTarget(copy.draft_id)).toBeNull();
    expect(() => workspace.install(copy.draft_id, copy.revision, pub.motif_id)).toThrow(/version conflict/);
    expect(workspace.install(copy.draft_id, copy.revision, pub.motif_id, 1).version).toBe(2);
    const edited = workspace.update(draft.draft_id, draft.revision, [{ path: 'scene.js', text: 'new' }]);
    expect(() => workspace.install(draft.draft_id, edited.revision)).toThrow(/version conflict/);
});
