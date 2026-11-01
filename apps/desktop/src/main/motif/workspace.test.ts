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
    expect(workspace.open({ kind: 'directory', path: directory }).motif_id).toBe(first.motif_id);
    writeFileSync(path.join(directory, 'index.html'), '<html><body>two</body></html>');
    const next = workspace.read(first.motif_id);
    expect(next.revision).not.toBe(first.revision);
    expect(store.readHtml(first.motif_id)).toContain('two');
    workspace.delete(first.motif_id);
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toContain('two');
});
it('updates several files together, refuses stale revisions, and publishes a retained draft exactly once', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []);
    const draft = workspace.open({ kind: 'directory', path: folder() });
    const next = workspace.update(draft.motif_id, draft.revision, [{ path: 'scene.js', text: 'export const color="red"' }, { path: 'index.html', text: '<html>new</html>' }]);
    expect(() => workspace.update(draft.motif_id, draft.revision, [{ path: 'scene.js', delete: true }])).toThrow(/revision/i);
    expect(() => workspace.update(draft.motif_id, next.revision, [{ path: 'index.html', delete: true }, { path: 'scene.js', delete: true }])).toThrow(/index.html/);
    expect(store.readFile(draft.motif_id, 'scene.js')).not.toBeNull();
    const published = workspace.publish(draft.motif_id, next.revision);
    expect(published.motif_id).not.toBe(draft.motif_id);
    expect(store.getDraft(draft.motif_id)).not.toBeNull();
    expect(workspace.publish(draft.motif_id, next.revision)).toEqual(published);
    workspace.update(draft.motif_id, next.revision, [{ path: 'scene.js', text: 'blue' }]);
    expect(store.readFile(published.motif_id, 'scene.js')?.toString()).toContain('red');
});
it('applies exact-match edits in order and writes them through to a linked directory', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []), directory = folder();
    writeFileSync(path.join(directory, 'scene.js'), 'const a = 1;\nconst b = 2;\n');
    const draft = workspace.open({ kind: 'directory', path: directory });
    const next = workspace.update(draft.motif_id, draft.revision, [
        { path: 'scene.js', edits: [{ old: 'a = 1', new: 'a = 10' }, { old: 'a = 10;\nconst b', new: 'a = 10;\nlet b' }] },
        { path: 'index.html', edits: [{ old: 'one', new: '' }] },
    ]);
    expect(next.revision).not.toBe(draft.revision);
    expect(readFileSync(path.join(directory, 'scene.js'), 'utf8')).toBe('const a = 10;\nlet b = 2;\n');
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toBe('<html><body></body></html>');
    expect(store.readFile(draft.motif_id, 'scene.js')?.toString()).toContain('let b');
});
it('refuses an edit that does not match exactly once, and changes nothing in the batch', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []), directory = folder();
    writeFileSync(path.join(directory, 'scene.js'), 'x x');
    const draft = workspace.open({ kind: 'directory', path: directory });
    const tryEdit = (edit: Record<string, unknown>) => workspace.update(draft.motif_id, draft.revision, [{ path: 'index.html', text: '<html>changed</html>' }, edit as never]);
    expect(() => tryEdit({ path: 'scene.js', edits: [{ old: 'y', new: 'z' }] })).toThrow(/scene\.js edit 1: old text not found/);
    expect(() => tryEdit({ path: 'scene.js', edits: [{ old: 'x', new: 'z' }] })).toThrow(/scene\.js edit 1: old text matches 2 times/);
    expect(() => tryEdit({ path: 'missing.js', edits: [{ old: 'x', new: 'z' }] })).toThrow(/missing\.js/);
    expect(() => tryEdit({ path: 'scene.js', edits: [{ old: '', new: 'z' }] })).toThrow(/old text/);
    expect(() => tryEdit({ path: 'scene.js', edits: [] })).toThrow(/exactly one/);
    expect(() => tryEdit({ path: 'scene.js', text: 'a', edits: [{ old: 'x x', new: 'z' }] })).toThrow(/exactly one/);
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toContain('one');
    expect(workspace.read(draft.motif_id).revision).toBe(draft.revision);
});
function tools(store: UserMotifStore) {
    return (name: string, args: Record<string, unknown> = {}) => runMotifTool(name, args, { store, builtins: [], motifLayers: () => [], dispatchRebind: () => { }, emitChanged: () => { }, refreshCatalog: () => { }, emitLog: () => { } }) as any;
}
it('writes, reads and exports binary companions through public tools without a shared folder', () => {
    const store = new UserMotifStore(temp()), call = tools(store);
    const draft = call('open_motif_draft', { source: { kind: 'empty', name: 'Files' } });
    const bytes = Buffer.from([0, 255, 1]), sha256 = createHash('sha256').update(bytes).digest('hex');
    const edited = call('update_motif_files', { motif_id: draft.motif_id, expected_revision: draft.revision, files: [{ path: 'assets/model.glb', base64: bytes.toString('base64') }, { path: 'scene.js', text: 'hello' }] });
    expect(store.readFile(draft.motif_id, 'assets/model.glb')).toEqual(bytes);
    const info = call('read_motif', { motif_id: draft.motif_id });
    expect(info.html).toBeUndefined();
    // A binary file answers its size and digest only; a UTF-8 file its text.
    expect(call('read_motif', { motif_id: draft.motif_id, path: 'assets/model.glb' })).toEqual({ motif_id: draft.motif_id, revision: edited.revision, path: 'assets/model.glb', size: 3, sha256 });
    expect(call('read_motif', { motif_id: draft.motif_id, path: 'scene.js' }).text).toBe('hello');
    expect(() => call('read_motif', { motif_id: draft.motif_id, path: 'scene.js', encoding: 'text' })).toThrow(/takes no encoding/);
    const out = path.join(temp(), 'files.zip');
    expect(call('export_motif', { motif_id: draft.motif_id, expected_revision: edited.revision, path: out })).toEqual({ motif_id: draft.motif_id, revision: edited.revision, path: out });
    expect(() => call('export_motif', { motif_id: draft.motif_id })).toThrow(/needs path/);
    const imported = call('open_motif_draft', { source: { kind: 'zip', path: out } });
    expect(store.readFile(imported.motif_id, 'assets/model.glb')).toEqual(bytes);
    call('update_motif_files', { motif_id: draft.motif_id, expected_revision: edited.revision, files: [{ path: 'scene.js', text: 'replaced' }, { path: 'assets/model.glb', delete: true }] });
    expect(store.readFile(draft.motif_id, 'assets/model.glb')).toBeNull();
    for (const name of ['write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'get_motif_source', 'begin_file_upload', 'write_file_chunk', 'read_file_transfer', 'delete_file_transfer', 'copy_motif_draft'])
        expect(() => call(name, {})).toThrow(/unhandled/);
});
it('bounds and checks the inline base64 form, and names the replacement for the file_id arms', () => {
    const store = new UserMotifStore(temp()), call = tools(store);
    const draft = call('open_motif_draft', { source: { kind: 'empty', name: 'Caps' } });
    const write = (files: unknown[]) => call('update_motif_files', { motif_id: draft.motif_id, expected_revision: draft.revision, files });
    const kib = (n: number) => Buffer.alloc(n * 1024, 7).toString('base64');
    expect(write([{ path: 'a.bin', base64: kib(256) }]).revision).not.toBe(draft.revision);
    const again = call('read_motif', { motif_id: draft.motif_id }).revision;
    const writeAgain = (files: unknown[]) => call('update_motif_files', { motif_id: draft.motif_id, expected_revision: again, files });
    expect(() => writeAgain([{ path: 'b.bin', base64: kib(257) }])).toThrow(/over 256 KiB decoded/);
    expect(() => writeAgain(Array.from({ length: 17 }, (_, i) => ({ path: `p${i}.bin`, base64: kib(256) })))).toThrow(/over 4 MiB/);
    for (const bad of ['not base64!', 'AAA', 'AA==\n', 'A A='])
        expect(() => writeAgain([{ path: 'c.bin', base64: bad }]), bad).toThrow(/invalid base64/);
    expect(() => writeAgain([{ path: 'c.bin', base64: 'AA==', text: 'x' }])).toThrow(/exactly one/);
    expect(() => writeAgain([{ path: 'c.bin', file_id: '00000000-0000-0000-0000-000000000000' }])).toThrow(/file_id uploads are gone; send \{path, base64\}/);
    expect(() => writeAgain([{ path: 'c.bin', text: 'x', mode: 'w' }])).toThrow(/not mode/);
    expect(() => call('open_motif_draft', { source: { kind: 'zip', file_id: 'x' } })).toThrow(/\{kind:'zip', path\}/);
    expect(store.readFile(draft.motif_id, 'b.bin')).toBeNull();
    expect(call('read_motif', { motif_id: draft.motif_id }).revision).toBe(again);
});
it('refuses a text file over 256 KiB rather than truncating it', () => {
    const store = new UserMotifStore(temp()), call = tools(store);
    const draft = call('open_motif_draft', { source: { kind: 'empty', name: 'Big' } });
    call('update_motif_files', { motif_id: draft.motif_id, expected_revision: draft.revision, files: [{ path: 'big.js', text: 'x'.repeat(256 * 1024 + 1) }] });
    expect(() => call('read_motif', { motif_id: draft.motif_id, path: 'big.js' })).toThrow(/257 KiB of text, over read_motif's 256 KiB/);
});
it('copies any Motif, a linked draft included, into an independent app-owned draft (the UI "save as new")', () => {
    const store = new UserMotifStore(temp()), call = tools(store), directory = folder();
    mkdirSync(path.join(directory, 'assets'));
    writeFileSync(path.join(directory, 'assets', 'a.bin'), Buffer.from([1, 2, 3]));
    const draft = call('open_motif_draft', { source: { kind: 'directory', path: directory } });
    // Opening the draft id resumes it; a copy source does not.
    expect(call('open_motif_draft', { source: { kind: 'motif', motif_id: draft.motif_id } }).motif_id).toBe(draft.motif_id);
    const copy = call('open_motif_draft', { source: { kind: 'copy', motif_id: draft.motif_id } });
    expect(copy.motif_id).not.toBe(draft.motif_id);
    expect(store.readFile(copy.motif_id, 'assets/a.bin')).toEqual(Buffer.from([1, 2, 3]));
    expect(store.readHtml(copy.motif_id)).toContain('one');
    const copied = call('read_motif', { motif_id: copy.motif_id });
    expect(copied.status).toBe('draft');
    expect(copied.directory).toBeUndefined();
    // Edits to the copy stay in the copy.
    call('update_motif_files', { motif_id: copy.motif_id, expected_revision: copy.revision, files: [{ path: 'index.html', text: '<html><body>copy</body></html>' }] });
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toContain('one');
    // An invalid linked draft is refused, not copied from its last valid snapshot.
    writeFileSync(path.join(directory, 'manifest.json'), '{broken');
    expect(() => call('open_motif_draft', { source: { kind: 'copy', motif_id: draft.motif_id } })).toThrow();
});
it('reports invalid linked edits without losing the draft, blocks publication and recovers after repair', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []), directory = folder();
    const draft = workspace.open({ kind: 'directory', path: directory });
    writeFileSync(path.join(directory, 'manifest.json'), '{broken');
    expect(workspace.read(draft.motif_id).diagnostic).toBeTruthy();
    expect(workspace.list('draft')).toHaveLength(1);
    expect(() => store.assertRenderable(draft.motif_id)).toThrow(/invalid/);
    expect(() => workspace.publish(draft.motif_id, draft.revision)).toThrow(/invalid/);
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    expect(workspace.read(draft.motif_id).diagnostic).toBeUndefined();
    expect(workspace.publish(draft.motif_id, draft.revision).version).toBe(1);
});
it('refuses escaping paths, path collisions and directory junctions before modifying files', () => {
    const workspace = new MotifWorkspace(new UserMotifStore(temp()), []), directory = folder();
    const draft = workspace.open({ kind: 'directory', path: directory });
    for (const name of ['../escape', 'C:/escape', 'target', 'a\\b'])
        expect(() => workspace.update(draft.motif_id, draft.revision, [{ path: name, text: 'bad' }])).toThrow();
    expect(() => workspace.update(draft.motif_id, draft.revision, [{ path: 'Asset/a', text: 'x' }, { path: 'asset/b', text: 'x' }])).toThrow(/Conflicting/);
    const outside = temp();
    mkdirSync(path.join(outside, 'assets'));
    symlinkSync(outside, path.join(directory, 'linked'), 'junction');
    expect(workspace.read(draft.motif_id).diagnostic).toMatch(/symbolic/);
    expect(readFileSync(path.join(directory, 'index.html'), 'utf8')).toContain('one');
    rmSync(path.join(directory, 'linked'));
});
it('keeps a capture navigation on the same resource bytes while the directory advances', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []), directory = folder();
    writeFileSync(path.join(directory, 'scene.js'), 'old');
    const draft = workspace.open({ kind: 'directory', path: directory });
    expect(store.pinPackage(draft.motif_id, draft.revision)).toBe(true);
    writeFileSync(path.join(directory, 'scene.js'), 'new');
    const next = workspace.read(draft.motif_id);
    expect(next.revision).not.toBe(draft.revision);
    expect(store.readFile(draft.motif_id, `.revisions/${draft.revision}/scene.js`)?.toString()).toBe('old');
    expect(store.readFile(draft.motif_id, 'scene.js')?.toString()).toBe('new');
});
it('requires an explicit target version and rejects a second editor overwriting a newer publication', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []);
    const draft = workspace.open({ kind: 'empty', name: 'Original' }), pub = workspace.publish(draft.motif_id, draft.revision);
    const copy = workspace.open({ kind: 'motif', motif_id: pub.motif_id });
    expect(store.readDraftTarget(copy.motif_id)).toBeNull();
    expect(() => workspace.publish(copy.motif_id, copy.revision, pub.motif_id)).toThrow(/version conflict/);
    expect(workspace.publish(copy.motif_id, copy.revision, pub.motif_id, 1).version).toBe(2);
    const edited = workspace.update(draft.motif_id, draft.revision, [{ path: 'scene.js', text: 'new' }]);
    expect(() => workspace.publish(draft.motif_id, edited.revision)).toThrow(/version conflict/);
});
it('export_motif with a path writes a new .zip only: an existing file, another extension or a missing folder is refused (ME1)', () => {
    const store = new UserMotifStore(temp()), workspace = new MotifWorkspace(store, []);
    const draft = workspace.open({ kind: 'directory', path: folder() });
    const call = (args: Record<string, unknown>) => runMotifTool('export_motif', { motif_id: draft.motif_id, ...args }, { store, builtins: [], motifLayers: () => [], dispatchRebind: () => { }, emitChanged: () => { }, refreshCatalog: () => { }, emitLog: () => { } }) as any;
    const out = temp();
    const target = path.join(out, 'card.zip');
    expect(call({ path: target }).path).toBe(target);
    const written = readFileSync(target);
    expect(() => call({ path: target })).toThrow(/EEXIST/);
    expect(readFileSync(target)).toEqual(written);
    expect(() => call({ path: path.join(out, 'card.txt') })).toThrow(/\.zip/);
    expect(() => call({ path: path.join(out, 'no-such-folder', 'card.zip') })).toThrow(/ENOENT/);
});
