import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { type Manifest, parseManifestIsland, composeMotifHtml, validateManifest, assignUniqueId, BUILTIN_IDS } from '../../shared/motifs/catalog';
import { type BuiltinMotif, getMotifSource, motifSourceFiles, listMotifsInner, buildRebindUpdates, type MotifLayerRef } from './authoring';
import { type MotifFile, motifFileSegments, readMotifDirectory } from './packageFiles';
import { motifContentHash } from './contentHash';
import { readMotifZip } from './archive';
import type { UserMotifStore } from './store';
export type DraftSource = {
    kind: 'directory';
    path: string;
} | {
    kind: 'zip';
    path: string;
} | {
    kind: 'motif';
    id: string;
} | {
    kind: 'empty';
    name?: string;
};
export interface FileChange {
    path: string;
    text?: string;
    file_id?: string;
    delete?: boolean;
}
interface DraftState {
    directory?: string;
    source_id?: string;
    diagnostic?: string;
    publication?: {
        id: string;
        revision: string;
        version: number;
    };
}
export function packageRevision(files: readonly MotifFile[]): string {
    const hash = createHash('sha256');
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
        hash.update(JSON.stringify([file.path, file.bytes.length])).update(file.bytes);
    return hash.digest('hex');
}
function safeId(id: string): string {
    if (typeof id !== 'string' || motifFileSegments(id)?.length !== 1 || id.startsWith('.'))
        throw new Error('Invalid Motif id');
    return id;
}
export function validateFiles(files: readonly MotifFile[]): void {
    const nodes = new Map<string, string>();
    let total = 0;
    for (const file of files) {
        const parts = motifFileSegments(file.path);
        if (!parts || ['target', '.revisions'].includes(parts[0].toLowerCase()))
            throw new Error('Invalid Motif file path: ' + file.path);
        for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase(), kind = i === parts.length ? 'file' : 'dir';
            const value = kind + ':' + prefix, previous = nodes.get(key);
            if (previous && (previous !== value || kind === 'file'))
                throw new Error('Conflicting Motif file path: ' + file.path);
            nodes.set(key, value);
        }
        total += file.bytes.length;
    }
    if (files.length > 10000 || total > 256 * 1024 * 1024)
        throw new Error('Motif package exceeds 256 MiB / 10000 files');
}
function normalize(files: readonly MotifFile[], id: string, version = 1) {
    validateFiles(files);
    const html = files.find(f => f.path === 'index.html')?.bytes.toString('utf8');
    if (html === undefined)
        throw new Error('A Motif folder must contain index.html');
    const json = files.find(f => f.path === 'manifest.json');
    const input = json ? JSON.parse(json.bytes.toString('utf8')) : parseManifestIsland(html);
    const manifest = { ...input, id, version } as Manifest;
    validateManifest(manifest);
    const composed = composeMotifHtml(manifest, html);
    const normalized = [...files.filter(f => f.path !== 'index.html' && f.path !== 'manifest.json'),
        { path: 'index.html', bytes: Buffer.from(composed) }, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) }];
    validateFiles(normalized);
    return { manifest, html: composed, files: normalized, revision: motifContentHash(manifest, composed, normalized) };
}
/** Replace a whole app-owned package. A failed rename restores the old package. */
export function replacePackage(directory: string, files: readonly MotifFile[]): void {
    validateFiles(files);
    mkdirSync(path.dirname(directory), { recursive: true });
    const staging = directory + '.stage-' + randomUUID(), backup = directory + '.backup-' + randomUUID();
    mkdirSync(staging);
    try {
        for (const file of files) {
            const dest = path.join(staging, ...file.path.split('/'));
            mkdirSync(path.dirname(dest), { recursive: true });
            writeFileSync(dest, file.bytes);
        }
        if (existsSync(directory)) {
            if (lstatSync(directory).isSymbolicLink())
                throw new Error('Motif package cannot be a link');
            renameSync(directory, backup);
        }
        try {
            renameSync(staging, directory);
        }
        catch (error) {
            if (existsSync(backup))
                renameSync(backup, directory);
            throw error;
        }
        rmSync(backup, { recursive: true, force: true });
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
/** One authoring interface for linked directories and app-owned drafts. Rendering
 * reads only committed app-owned snapshots; author files never become protocol roots. */
export class MotifWorkspace {
    constructor(readonly store: UserMotifStore, readonly builtins: BuiltinMotif[]) { }
    private stateFile(id: string) { return path.join(this.store.root(), '.workspaces', safeId(id) + '.json'); }
    private state(id: string): DraftState { const file = this.stateFile(id); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; }
    private save(id: string, state: DraftState) {
        const file = this.stateFile(id);
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = file + '.tmp';
        writeFileSync(temp, JSON.stringify(state));
        renameSync(temp, file);
    }
    private draftDir(id: string) { return path.join(this.store.root(), 'drafts', safeId(id)); }
    private fresh(name: string) { return assignUniqueId(name, [...this.store.publishedIds(), ...this.store.listDraftIds()]); }
    private commit(id: string, files: readonly MotifFile[]) {
        const pkg = normalize(files, id);
        const old = this.store.getDraft(id);
        if (!old || motifContentHash(old.manifest, old.html, this.store.packageFiles(id)) !== pkg.revision)
            replacePackage(this.draftDir(id), pkg.files);
        return pkg;
    }
    sync(id: string): boolean {
        const state = this.state(id);
        if (!state.directory)
            return false;
        const before = this.store.getDraft(id);
        const old = before ? motifContentHash(before.manifest, before.html, this.store.packageFiles(id)) : null;
        try {
            const files = readMotifDirectory(state.directory);
            if (packageRevision(files) !== packageRevision(readMotifDirectory(state.directory)))
                throw new Error('Working directory changed while reading; retry after saving');
            const pkg = this.commit(id, files);
            if (state.diagnostic) {
                delete state.diagnostic;
                this.save(id, state);
            }
            return old !== pkg.revision;
        }
        catch (error) {
            const message = String(error);
            const changed = state.diagnostic !== message;
            if (changed) {
                state.diagnostic = message;
                this.save(id, state);
            }
            return changed;
        }
    }
    syncLinked(): boolean { let changed = false; for (const id of this.store.listDraftIds())
        changed = this.sync(id) || changed; return changed; }
    directoryRoots(): string[] { return this.store.listDraftIds().flatMap(id => { const directory = this.state(id).directory; return directory ? [directory] : []; }); }
    open(source: DraftSource) {
        if (!source || typeof source !== 'object' || !['directory', 'zip', 'motif', 'empty'].includes(source.kind))
            throw new Error('Invalid draft source');
        const allowed = source.kind === 'motif' ? ['kind', 'id'] : source.kind === 'empty' ? ['kind', 'name'] : ['kind', 'path'];
        if (Object.keys(source).some(k => !allowed.includes(k)))
            throw new Error('Source must specify exactly one source kind');
        if ((source.kind === 'directory' || source.kind === 'zip') && (typeof source.path !== 'string' || !path.isAbsolute(source.path)))
            throw new Error('Source path must be absolute');
        let files: MotifFile[], directory: string | undefined;
        if (source.kind === 'directory') {
            if (!path.isAbsolute(source.path) || lstatSync(source.path).isSymbolicLink())
                throw new Error('Use an absolute, non-link Motif directory');
            directory = realpathSync.native(source.path);
            const storeRoot = path.resolve(this.store.root());
            const contains = (a: string, b: string) => { const rel = path.relative(a, b); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
            if (contains(directory, storeRoot) || contains(storeRoot, directory))
                throw new Error('Working directory must be separate from the Motif store');
            for (const id of this.store.listDraftIds())
                if (this.state(id).directory === directory) {
                    const info = this.read(id);
                    return { draft_id: id, revision: info.revision };
                }
            files = readMotifDirectory(directory);
        }
        else if (source.kind === 'zip')
            files = readMotifZip(source.path);
        else if (source.kind === 'motif') {
            if (this.store.getDraft(source.id)) {
                const info = this.read(source.id);
                return { draft_id: source.id, revision: info.revision };
            }
            const src = getMotifSource(this.store, this.builtins, source.id);
            files = [...motifSourceFiles(this.store, this.builtins, source.id).filter(f => f.path !== 'index.html'), { path: 'index.html', bytes: Buffer.from(src.html) }];
        }
        else if (source.kind === 'empty')
            files = [{ path: 'index.html', bytes: Buffer.from('<!doctype html><html><body><script>motif.define({frame(t){}})</script></body></html>') },
                { path: 'manifest.json', bytes: Buffer.from(JSON.stringify({ name: source.name || 'Untitled Motif', size: [960, 540], default_duration_s: 5, props_schema: {} })) }];
        else
            throw new Error('Unknown Motif source kind');
        const opened = this.openFiles(files, directory);
        if (source.kind === 'motif') {
            const state = this.state(opened.draft_id);
            state.source_id = source.id;
            this.save(opened.draft_id, state);
        }
        return opened;
    }
    openFiles(files: MotifFile[], directory?: string) {
        const preliminary = normalize(files, 'draft');
        const id = this.fresh(preliminary.manifest.name);
        const pkg = this.commit(id, files);
        this.save(id, directory ? { directory } : {});
        return { draft_id: id, revision: pkg.revision };
    }
    read(id: string) {
        safeId(id);
        this.sync(id);
        const source = getMotifSource(this.store, this.builtins, id);
        const files = motifSourceFiles(this.store, this.builtins, id);
        if (!files.some(f => f.path === 'index.html'))
            files.push({ path: 'index.html', bytes: Buffer.from(source.html) });
        const state = this.state(id);
        return { ...source, id, revision: motifContentHash(source.manifest, source.html, files),
            status: BUILTIN_IDS.includes(id) ? 'builtin' : this.store.getDraft(id) ? 'draft' : 'installed',
            ...(state.directory ? { directory: state.directory } : {}), ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
            ...(state.publication ? { publication: state.publication } : {}),
            files: files.map(f => ({ path: f.path, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') })) };
    }
    list(status?: string) {
        this.syncLinked();
        return listMotifsInner(this.store, this.builtins).filter(e => !status || e.status === status).map(e => {
            const state = this.state(e.id as string);
            return { ...e, revision: e.content_hash, ...(state.directory ? { directory: state.directory } : {}), ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
                ...(state.source_id ? { source_id: state.source_id } : {}),
                ...(state.publication ? { target_id: state.publication.id } : {}) };
        });
    }
    update(id: string, expected: string, changes: FileChange[], resolveFile?: (id: string) => Buffer) {
        const info = this.read(id), state = this.state(id);
        if (info.status !== 'draft')
            throw new Error('Only drafts can be edited; open a draft first');
        if (!expected || expected !== info.revision)
            throw new Error('Motif revision conflict; read the draft again');
        if (!Array.isArray(changes) || !changes.length || changes.length > 10000)
            throw new Error('Provide 1–10000 file changes');
        const original = state.directory ? readMotifDirectory(state.directory) : this.store.packageFiles(id);
        const files = new Map(original.map(f => [f.path, f.bytes])), touched = new Set<string>();
        for (const change of changes) {
            if (typeof change.path !== 'string' || !motifFileSegments(change.path) || change.path.split('/')[0].toLowerCase() === 'target')
                throw new Error('Invalid file path');
            if (touched.has(change.path.toLowerCase()))
                throw new Error('Duplicate file change: ' + change.path);
            touched.add(change.path.toLowerCase());
            const kinds = Number(typeof change.text === 'string') + Number(typeof change.file_id === 'string') + Number(change.delete === true);
            if (kinds !== 1)
                throw new Error('Each file change needs exactly one of text, file_id or delete:true');
            if (change.delete)
                files.delete(change.path);
            else
                files.set(change.path, change.text !== undefined ? Buffer.from(change.text) : resolveFile ? resolveFile(change.file_id!) : (() => { throw new Error('No file transfer available'); })());
        }
        const next = [...files].map(([path, bytes]) => ({ path, bytes }));
        normalize(next, id); // validate the complete transaction before changing anything
        if (state.directory) {
            // The renderer observes only the committed mirror. Roll back source writes
            // on filesystem failure; never replace/move the author's directory itself.
            if (packageRevision(original) !== packageRevision(readMotifDirectory(state.directory)))
                throw new Error('Working directory changed during update');
            const applied: string[] = [];
            try {
                for (const change of changes) {
                    const dest = path.join(state.directory, ...change.path.split('/'));
                    const bytes = files.get(change.path);
                    if (bytes) {
                        mkdirSync(path.dirname(dest), { recursive: true });
                        const temp = dest + '.motif-' + randomUUID();
                        try {
                            writeFileSync(temp, bytes);
                            renameSync(temp, dest);
                        }
                        finally {
                            rmSync(temp, { force: true });
                        }
                    }
                    else
                        rmSync(dest, { force: true });
                    applied.push(change.path);
                }
                this.commit(id, next);
            }
            catch (error) {
                for (const name of applied.reverse()) {
                    const dest = path.join(state.directory, ...name.split('/')), old = original.find(f => f.path === name);
                    if (old)
                        writeFileSync(dest, old.bytes);
                    else
                        rmSync(dest, { force: true });
                }
                throw error;
            }
        }
        else
            this.commit(id, next);
        if (state.diagnostic) {
            delete state.diagnostic;
            this.save(id, state);
        }
        return { draft_id: id, revision: this.read(id).revision };
    }
    install(id: string, expected: string, targetId?: string, expectedVersion?: number, layers: MotifLayerRef[] = []) {
        const info = this.read(id), state = this.state(id);
        if (info.status !== 'draft')
            throw new Error('Only drafts can be installed');
        if (info.diagnostic)
            throw new Error('Working directory is invalid: ' + info.diagnostic);
        if (!expected || expected !== info.revision)
            throw new Error('Motif revision conflict; preview the current revision');
        const target = targetId ?? state.publication?.id;
        if (target && BUILTIN_IDS.includes(target))
            throw new Error('Cannot overwrite a built-in Motif');
        const prev = target ? this.store.listManifests().find(m => m.id === target) : undefined;
        if (target && !prev)
            throw new Error('Update target must be an installed Motif');
        if (state.publication && state.publication.id === target && state.publication.revision === expected && prev?.version === state.publication.version) {
            return { motif_id: target!, version: prev.version, revision: expected, updates: buildRebindUpdates(layers, id, prev) };
        }
        if (prev && (expectedVersion ?? (state.publication?.id === target ? state.publication?.version : undefined)) !== prev.version)
            throw new Error('Published version conflict; supply expected_version from read_motif');
        const finalId = target ?? this.fresh(info.manifest.name), version = prev ? prev.version + 1 : 1;
        const pkg = normalize(this.store.packageFiles(id), finalId, version);
        replacePackage(path.join(this.store.root(), safeId(finalId)), pkg.files);
        state.publication = { id: finalId, revision: expected, version };
        this.save(id, state);
        return { motif_id: finalId, version, revision: expected, updates: buildRebindUpdates(layers, id, pkg.manifest) };
    }
    delete(id: string) {
        safeId(id);
        if (BUILTIN_IDS.includes(id))
            throw new Error('Cannot delete a built-in Motif');
        if (!this.store.getMotif(id) && !this.store.getDraft(id))
            throw new Error('Unknown Motif: ' + id);
        this.store.deleteUserMotif(id);
        rmSync(this.stateFile(id), { force: true });
    }
}
