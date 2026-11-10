import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { type Manifest, parseManifestIsland, composeMotifHtml, validateManifest, assignUniqueId, sanitizeId, BUILTIN_IDS } from '../../shared/motifs/catalog';
import type { MotifRebindEntry } from '../state/model';
import { type BuiltinMotif, getMotifSource, motifRevision, motifSourceFiles, listMotifsInner, buildRebindUpdates, type MotifLayerRef } from './authoring';
import { type MotifFile, motifFileSegments, readMotifDirectory, sameStamps, stampMotifDirectory } from './packageFiles';
import type { PackageOutcome } from './packageRevisions';
import { motifContentHash } from './contentHash';
import { readMotifZip } from './archive';
import { DRAFTS_DIR, PROPOSALS_DIR, isProposalPreviewId, proposalPreviewId, type UserMotifStore } from './store';
import { MotifRefusal, revisionConflict } from './refusal';
/** Where a draft comes from. `motif` resumes a draft id and copies any other
 *  Motif (recording it as the source); `copy` always makes an independent copy. */
export type DraftSource = {
    kind: 'directory';
    path: string;
} | {
    kind: 'zip';
    path: string;
} | {
    kind: 'motif';
    motif_id: string;
} | {
    kind: 'copy';
    motif_id: string;
} | {
    kind: 'empty';
    name?: string;
};
/** What an `empty` source starts as. */
export const EMPTY_DRAFT = { name: 'Untitled Motif', size: [960, 540] as [number, number], default_duration_s: 5 };
export type PublicationState = 'awaiting_approval' | 'approved' | 'rejected';
/** An update replaces `id` at `version`; a first publication takes `new_id`. */
export type ProposalTarget = { id: string; version: number } | { new_id: string };
export interface ReboundLayer { layer_id: string; dropped_props: string[] }
/** One proposed publication of a draft (ADR 0046): the agent proposes, the
 *  user approves or rejects it in the Motif panel. Stored with the draft's
 *  state; the frozen package sits under `<store>/.proposals/<draft id>/`. */
export interface Proposal {
    proposal_id: string;
    state: PublicationState;
    revision: string;
    target: ProposalTarget;
    proposed_at: string;
    decided_at?: string;
    note?: string;
    /** The version approval published. */
    version?: number;
    rebound?: ReboundLayer[];
    /** A draft from before draft ids carried `-draft` holds its name's id;
     *  approving its first publication moves it to `<id>-draft`. */
    renamed_draft?: { from: string; to: string };
}
/** The answer `install_motif` gives, and the `publication` a draft row carries. */
export interface PublicationView {
    state: PublicationState;
    proposal_id: string;
    revision: string;
    target: ProposalTarget;
    note?: string;
    version?: number;
    rebound?: ReboundLayer[];
    renamed_draft?: { from: string; to: string };
}
export interface ProposalDiff {
    files: { added: string[]; removed: string[]; changed: string[] };
    props: { added: string[]; removed: string[]; changed: string[] };
}
/** One pending proposal as the Motif panel's card shows it. */
export interface ProposalCard extends PublicationView {
    motif_id: string;
    proposed_at: string;
    /** The id the frozen package is served and previewed under. */
    preview_id: string;
    manifest: Manifest;
    /** Against the current published version; null for a first publication. */
    diff: ProposalDiff | null;
    /** Layers of the open project that approval rebinds. */
    rebinds: string[];
}
const NOTE_CHARS = 500;
/** An exact-match replacement inside one UTF-8 file: `old` must occur exactly once. */
export interface TextEdit {
    old: string;
    new: string;
}
export interface FileChange {
    path: string;
    text?: string;
    /** Canonical base64 of the whole file: the one inline form for binary bytes. */
    base64?: string;
    delete?: boolean;
    edits?: TextEdit[];
}
/** The inline binary form's bounds: one entry, and one call's entries together. */
export const INLINE_FILE_BYTES = 256 * 1024;
export const INLINE_CALL_BYTES = 4 * 1024 * 1024;
const CHANGE_KEYS: ReadonlySet<string> = new Set(['path', 'text', 'base64', 'edits', 'delete']);
/** Decode one `{path, base64}` entry: canonical base64 only, bounded before decoding. */
function inlineBytes(filePath: string, base64: string): Buffer {
    if (base64.length > Math.ceil(INLINE_FILE_BYTES / 3) * 4)
        throw new Error(`${filePath}: base64 is over 256 KiB decoded; open a directory draft or a {kind:'zip', path} source for larger files`);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64)
        throw new Error(`${filePath}: invalid base64; send the file's canonical base64 (A-Z a-z 0-9 + /, = padding, no whitespace)`);
    return bytes;
}
/** Apply edits in order, each against the text the previous one left. A miss or
 *  an ambiguous match refuses the whole batch, so a client resends a small diff
 *  rather than the complete file. */
function applyEdits(filePath: string, bytes: Buffer | undefined, edits: TextEdit[]): Buffer {
    if (!bytes)
        throw new Error(`Cannot edit ${filePath}: no such file in the draft`);
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    edits.forEach((edit, i) => {
        const where = `${filePath} edit ${i + 1}`;
        if (!edit || typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string')
            throw new Error(`${where}: needs a non-empty old text and a new text`);
        const at = text.indexOf(edit.old);
        if (at < 0)
            throw new Error(`${where}: old text not found; read the file again`);
        let count = 0;
        for (let k = at; k >= 0; k = text.indexOf(edit.old, k + 1))
            count++;
        if (count > 1)
            throw new Error(`${where}: old text matches ${count} times; include more surrounding text`);
        text = text.slice(0, at) + edit.new + text.slice(at + edit.old.length);
    });
    return Buffer.from(text);
}
interface DraftState {
    directory?: string;
    source_id?: string;
    diagnostic?: string;
    /** The last publication made from this draft. */
    publication?: {
        id: string;
        revision: string;
        version: number;
    };
    /** The latest proposal; a newer one supersedes it. */
    proposal?: Proposal;
}
function view(p: Proposal): PublicationView {
    return { state: p.state, proposal_id: p.proposal_id, revision: p.revision, target: p.target,
        ...(p.note ? { note: p.note } : {}), ...(p.version ? { version: p.version } : {}), ...(p.rebound ? { rebound: p.rebound } : {}),
        ...(p.renamed_draft ? { renamed_draft: p.renamed_draft } : {}) };
}
const sameTarget = (a: ProposalTarget, b: ProposalTarget) => JSON.stringify(a) === JSON.stringify(b);
/** Prop keys a layer had that the published schema no longer has. */
function droppedProps(props: Record<string, unknown>, manifest: Manifest): string[] {
    return Object.keys(props ?? {}).filter(k => !(k in manifest.props_schema)).sort();
}
function safeId(id: string): string {
    // A proposal's preview id (`<draft>--proposal`) serves the card's preview
    // player only; no tool reads, edits or deletes through it.
    if (typeof id !== 'string' || motifFileSegments(id)?.length !== 1 || id.startsWith('.') || isProposalPreviewId(id))
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
 * reads only committed app-owned snapshots; author files never become protocol roots.
 *
 * Publication is two steps for an agent (ADR 0046): `propose` freezes a
 * revision as a pending publication and leaves the library alone; the user's
 * `approve` in the Motif panel publishes it, `reject` keeps the draft with a
 * note. The app's own buttons `publish` directly: the user is the approver. */
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
    private proposalDir(id: string) { return path.join(this.store.root(), PROPOSALS_DIR, safeId(id)); }
    private allIds() { return [...this.store.publishedIds(), ...this.store.listDraftIds()]; }
    /** Draft ids carry a `-draft` suffix, so the name's own id stays free for
     *  the draft's first publication. */
    private freshDraftId(name: string) { return assignUniqueId(`${name} draft`, [...this.allIds(), ...this.pendingNewIds('').keys()]); }
    private commit(id: string, files: readonly MotifFile[]) {
        const pkg = normalize(files, id);
        this.put(id, pkg);
        return pkg;
    }
    private put(id: string, pkg: ReturnType<typeof normalize>) {
        if (this.store.draftRevision(id) !== pkg.revision)
            replacePackage(this.draftDir(id), pkg.files);
    }
    /** What a linked directory's files come to, committed to the draft's
     *  app-owned package. The directory is read only when its files changed
     *  since that was recorded, or the package no longer holds it (ADR 0164). */
    private mirror(id: string, directory: string, mirrored: string | null): PackageOutcome {
        const revisions = this.store.revisions;
        try {
            const known = revisions.lookup(directory, revisions.stamp(directory));
            if (known && ('diagnostic' in known || known.revision === mirrored))
                return known;
            const { files, stamp } = revisions.read(directory);
            if (!stamp)
                throw new Error('Working directory changed while reading; retry after saving');
            let pkg: ReturnType<typeof normalize>;
            try {
                pkg = normalize(files, id);
            }
            catch (error) {
                // Only what the files themselves decide is recorded: a failed
                // read or write of the package is tried again next time.
                const refused = { diagnostic: String(error) };
                revisions.record(directory, stamp, refused);
                return refused;
            }
            this.put(id, pkg);
            const outcome = { revision: pkg.revision };
            revisions.record(directory, stamp, outcome);
            return outcome;
        }
        catch (error) {
            return { diagnostic: String(error) };
        }
    }
    sync(id: string): boolean {
        const state = this.state(id);
        if (!state.directory)
            return false;
        const before = this.store.draftRevision(id);
        const outcome = this.mirror(id, state.directory, before);
        if ('revision' in outcome) {
            if (state.diagnostic) {
                delete state.diagnostic;
                this.save(id, state);
            }
            return before !== outcome.revision;
        }
        const changed = state.diagnostic !== outcome.diagnostic;
        if (changed) {
            state.diagnostic = outcome.diagnostic;
            this.save(id, state);
        }
        return changed;
    }
    syncLinked(): boolean { let changed = false; for (const id of this.store.listDraftIds())
        changed = this.sync(id) || changed; return changed; }
    directoryRoots(): string[] { return this.store.listDraftIds().flatMap(id => { const directory = this.state(id).directory; return directory ? [directory] : []; }); }
    open(source: DraftSource) {
        if (!source || typeof source !== 'object' || !['directory', 'zip', 'motif', 'copy', 'empty'].includes(source.kind))
            throw new Error('Invalid draft source');
        if (source.kind === 'zip' && 'file_id' in source)
            throw new Error("A ZIP source is {kind:'zip', path} with an absolute app-machine path; file_id uploads are gone");
        const allowed = source.kind === 'motif' || source.kind === 'copy' ? ['kind', 'motif_id'] : source.kind === 'empty' ? ['kind', 'name'] : ['kind', 'path'];
        if (Object.keys(source).some(k => !allowed.includes(k)))
            throw new Error(`A ${source.kind} source takes ${allowed.slice(1).join(', ')} only`);
        if ((source.kind === 'directory' || source.kind === 'zip') && (typeof source.path !== 'string' || !path.isAbsolute(source.path)))
            throw new Error('Source path must be absolute');
        if (source.kind === 'copy')
            return this.copy(source.motif_id);
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
                    return { motif_id: id, revision: info.revision };
                }
            files = readMotifDirectory(directory);
        }
        else if (source.kind === 'zip')
            files = readMotifZip(source.path);
        else if (source.kind === 'motif') {
            // A draft id resumes that draft; any other id copies.
            if (this.store.getDraft(source.motif_id)) {
                const info = this.read(source.motif_id);
                return { motif_id: source.motif_id, revision: info.revision };
            }
            const src = getMotifSource(this.store, this.builtins, source.motif_id);
            files = [...motifSourceFiles(this.store, this.builtins, source.motif_id).filter(f => f.path !== 'index.html'), { path: 'index.html', bytes: Buffer.from(src.html) }];
        }
        else if (source.kind === 'empty')
            files = [{ path: 'index.html', bytes: Buffer.from('<!doctype html><html><body><script>motif.define({frame(t){}})</script></body></html>') },
                { path: 'manifest.json', bytes: Buffer.from(JSON.stringify({ ...EMPTY_DRAFT, name: source.name || EMPTY_DRAFT.name, props_schema: {} })) }];
        else
            throw new Error('Unknown Motif source kind');
        const opened = this.openFiles(files, directory);
        if (source.kind === 'motif') {
            const state = this.state(opened.motif_id);
            state.source_id = source.motif_id;
            this.save(opened.motif_id, state);
            const version = getMotifSource(this.store, this.builtins, source.motif_id).manifest.version;
            return { ...opened, source: { id: source.motif_id, version } };
        }
        return opened;
    }
    /** An independent app-owned draft from any Motif's complete package, drafts
     *  included: no linked directory, no source and no publication target. */
    copy(id: string) {
        const info = this.read(id);
        if (info.diagnostic)
            throw new Error(info.diagnostic);
        const files = motifSourceFiles(this.store, this.builtins, id).filter(f => f.path !== 'index.html' && f.path.split('/')[0].toLowerCase() !== 'target');
        return { ...this.openFiles([{ path: 'index.html', bytes: Buffer.from(info.html) }, ...files]), source: { id, version: info.manifest.version } };
    }
    openFiles(files: MotifFile[], directory?: string) {
        const preliminary = normalize(files, 'draft');
        const id = this.freshDraftId(preliminary.manifest.name);
        const pkg = this.commit(id, files);
        this.save(id, directory ? { directory } : {});
        return { motif_id: id, revision: pkg.revision };
    }
    read(id: string) {
        safeId(id);
        this.sync(id);
        const source = getMotifSource(this.store, this.builtins, id);
        const stored = this.builtins.some(b => b.id === id) ? null : this.store.packageSnapshot(id);
        const files = stored?.files ?? motifSourceFiles(this.store, this.builtins, id);
        if (!files.some(f => f.path === 'index.html'))
            files.push({ path: 'index.html', bytes: Buffer.from(source.html) });
        const state = this.state(id);
        return { ...source, id, revision: stored?.revision ?? motifRevision(this.store, this.builtins, id),
            status: BUILTIN_IDS.includes(id) ? 'builtin' : this.store.getDraft(id) ? 'draft' : 'installed',
            ...this.stateFields(state),
            files: files.map(f => ({ path: f.path, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') })) };
    }
    /** The draft fields a catalog row and a read share. */
    private stateFields(state: DraftState) {
        return { ...(state.directory ? { directory: state.directory } : {}), ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
            ...(state.source_id ? { source_id: state.source_id } : {}),
            ...(state.publication ? { target_id: state.publication.id } : {}),
            ...(state.proposal ? { publication: view(state.proposal) } : {}) };
    }
    list(status?: string) {
        this.syncLinked();
        return listMotifsInner(this.store, this.builtins).filter(e => !status || e.status === status).map(e => {
            const state = e.status === 'draft' ? this.state(e.id as string) : {};
            return { ...e, revision: e.content_hash, ...this.stateFields(state) };
        });
    }
    update(id: string, expected: string, changes: FileChange[]) {
        const info = this.read(id), state = this.state(id);
        if (info.status !== 'draft')
            throw new Error('Only drafts can be edited; open a draft first');
        if (!expected || expected !== info.revision)
            throw revisionConflict(info.revision, 'read the draft again and merge');
        if (!Array.isArray(changes) || !changes.length || changes.length > 10000)
            throw new Error('Provide 1–10000 file changes');
        const linked = state.directory ? this.store.revisions.read(state.directory) : null;
        const original = linked?.files ?? this.store.packageFiles(id);
        const files = new Map(original.map(f => [f.path, f.bytes])), touched = new Set<string>();
        let inline = 0;
        for (const change of changes) {
            if (!change || typeof change !== 'object')
                throw new Error('Each file change is an object with a path');
            if ('file_id' in change)
                throw new Error(`${String(change.path)}: file_id uploads are gone; send {path, base64} (at most 256 KiB decoded), or write the draft's linked directory`);
            const unknown = Object.keys(change).find(k => !CHANGE_KEYS.has(k));
            if (unknown !== undefined)
                throw new Error(`${String(change.path)}: a file change takes path plus one of text, base64, edits or delete:true, not ${unknown}`);
            if (typeof change.path !== 'string' || !motifFileSegments(change.path) || change.path.split('/')[0].toLowerCase() === 'target')
                throw new Error('Invalid file path');
            if (touched.has(change.path.toLowerCase()))
                throw new Error('Duplicate file change: ' + change.path);
            touched.add(change.path.toLowerCase());
            const hasEdits = Array.isArray(change.edits) && change.edits.length > 0;
            const kinds = Number(typeof change.text === 'string') + Number(typeof change.base64 === 'string') + Number(change.delete === true) + Number(hasEdits);
            if (kinds !== 1 || (change.edits !== undefined && !hasEdits))
                throw new Error('Each file change needs exactly one of text, base64, edits or delete:true');
            if (change.delete)
                files.delete(change.path);
            else if (hasEdits)
                files.set(change.path, applyEdits(change.path, files.get(change.path), change.edits!));
            else if (change.base64 !== undefined) {
                const bytes = inlineBytes(change.path, change.base64);
                inline += bytes.length;
                if (inline > INLINE_CALL_BYTES)
                    throw new Error('base64 entries total over 4 MiB decoded in one call; split the batch, or open a directory draft');
                files.set(change.path, bytes);
            }
            else
                files.set(change.path, Buffer.from(change.text!));
        }
        const next = [...files].map(([path, bytes]) => ({ path, bytes }));
        normalize(next, id); // validate the complete transaction before changing anything
        if (state.directory) {
            // The renderer observes only the committed mirror. Roll back source writes
            // on filesystem failure; never replace/move the author's directory itself.
            if (!linked?.stamp || !sameStamps(linked.stamp.files, stampMotifDirectory(state.directory)))
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
        return { motif_id: id, revision: this.read(id).revision };
    }
    /** The installed Motif a proposal or publication replaces, checked against
     *  the version the caller saw; null for a first publication. */
    private replaceTarget(state: DraftState, targetId: string | undefined, expectedVersion: number | undefined): { id: string; version: number } | null {
        const target = targetId ?? state.publication?.id;
        if (!target)
            return null;
        if (BUILTIN_IDS.includes(target))
            throw new MotifRefusal(`'${target}' is a built-in Motif and cannot be replaced; omit target_id to publish a new Motif`, { error: 'BuiltinMotif', id: target });
        const prev = this.store.listManifests().find(m => m.id === target);
        if (!prev) {
            // The recorded publication was deleted: the draft publishes anew.
            if (targetId === undefined)
                return null;
            throw new MotifRefusal(`target_id '${target}' is not an installed Motif — list_motifs { status: "installed" } lists them`, { error: 'MotifNotFound', id: target });
        }
        const seen = expectedVersion ?? (state.publication?.id === target ? state.publication.version : undefined);
        if (seen !== prev.version)
            throw new MotifRefusal(`Published version conflict: '${target}' is at version ${prev.version}; send expected_version ${prev.version} to replace it`, { error: 'VersionConflict', id: target, current_version: prev.version });
        return { id: target, version: prev.version };
    }
    /** New ids other drafts' pending proposals hold. */
    private pendingNewIds(except: string): Map<string, string> {
        const out = new Map<string, string>();
        for (const id of this.store.listDraftIds()) {
            const p = id === except ? undefined : this.state(id).proposal;
            if (p?.state === 'awaiting_approval' && 'new_id' in p.target)
                out.set(p.target.new_id, id);
        }
        return out;
    }
    /** The id a draft's first publication takes: its manifest name's. A name
     *  someone holds refuses with the ways forward; it is never numbered. */
    private newPublicationId(draftId: string, name: string): string {
        const id = sanitizeId(name);
        const installed = this.store.listManifests().find(m => m.id === id);
        const pending = this.pendingNewIds(draftId).get(id);
        const rename = "rename the draft's manifest name (the new id is made from it)";
        if (installed)
            throw new MotifRefusal(`Motif id '${id}' is taken by the installed Motif '${installed.name}' (version ${installed.version}); nothing was proposed — rename the draft's manifest name for a new id, or replace that Motif with target_id '${id}' and expected_version ${installed.version}`, { error: 'MotifIdTaken', id, holder: 'installed', options: [rename, `replace with target_id '${id}' + expected_version ${installed.version}`] });
        const holder: [string, string] | null = BUILTIN_IDS.includes(id) || id === DRAFTS_DIR ? ['builtin', 'a built-in Motif']
            // A draft whose own id is its name's (made before draft ids carried
            // `-draft`) does not collide with itself: approval moves it aside.
            : id !== draftId && this.store.listDraftIds().includes(id) ? ['draft', `the draft '${id}'`]
                : pending ? ['proposal', `a pending proposal from the draft '${pending}'`] : null;
        if (holder)
            throw new MotifRefusal(`Motif id '${id}' is taken by ${holder[1]}; nothing was proposed — rename the draft's manifest name for a new id`, { error: 'MotifIdTaken', id, holder: holder[0], options: [rename] });
        return id;
    }
    private publishable(id: string, expected: string, verb: string) {
        const info = this.read(id), state = this.state(id);
        if (info.status !== 'draft')
            throw new Error(`Only drafts can be ${verb}; open_motif_draft { kind: 'motif' } copies this Motif into one`);
        if (info.diagnostic)
            throw new Error('Working directory is invalid: ' + info.diagnostic);
        if (!expected || expected !== info.revision)
            throw revisionConflict(info.revision, 'preview the current revision, then send it');
        return { info, state };
    }
    /** Write version `version` of `finalId` from `files` and record it on the
     *  draft; the rebind updates for the open project's layers come back. */
    private writePublication(id: string, state: DraftState, files: readonly MotifFile[], revision: string, finalId: string, version: number, layers: MotifLayerRef[]) {
        const pkg = normalize(files, finalId, version);
        replacePackage(path.join(this.store.root(), safeId(finalId)), pkg.files);
        state.publication = { id: finalId, revision, version };
        const updates = buildRebindUpdates(layers, id, pkg.manifest);
        const rebound = updates.map(u => ({ layer_id: u.layer_id, dropped_props: droppedProps(layers.find(l => l.layerId === u.layer_id)?.props ?? {}, pkg.manifest) }));
        return { updates, rebound };
    }
    /** An agent's `install_motif`: freeze `expected` as a pending publication.
     *  The library is not touched; a newer proposal supersedes the older one. */
    propose(id: string, expected: string, targetId?: string, expectedVersion?: number): PublicationView & { superseded_proposal_id?: string } {
        const { info, state } = this.publishable(id, expected, 'proposed for publication');
        const replaces = this.replaceTarget(state, targetId, expectedVersion);
        if (replaces && state.publication?.id === replaces.id && state.publication.revision === expected && state.publication.version === replaces.version)
            return { state: 'approved', proposal_id: state.proposal?.proposal_id ?? '', revision: expected, target: replaces, version: replaces.version };
        const target: ProposalTarget = replaces ?? { new_id: this.newPublicationId(id, info.manifest.name) };
        const old = state.proposal;
        if (old?.state === 'awaiting_approval' && old.revision === expected && sameTarget(old.target, target))
            return view(old);
        replacePackage(this.proposalDir(id), this.store.packageFiles(id));
        state.proposal = { proposal_id: randomUUID(), state: 'awaiting_approval', revision: expected, target, proposed_at: new Date().toISOString() };
        this.save(id, state);
        return { ...view(state.proposal), ...(old?.state === 'awaiting_approval' ? { superseded_proposal_id: old.proposal_id } : {}) };
    }
    private pending(id: string, proposalId: string) {
        const state = this.state(id), p = state.proposal;
        if (!p || p.proposal_id !== proposalId)
            throw new MotifRefusal('This proposal was superseded or withdrawn; review the current one', { error: 'ProposalNotFound', proposal_id: proposalId });
        if (p.state !== 'awaiting_approval')
            throw new MotifRefusal(`This proposal was already ${p.state}`, { error: 'ProposalDecided', proposal_id: proposalId, state: p.state });
        return { state, proposal: p };
    }
    /** The user's approval: publish the frozen package, then rebind. */
    approve(id: string, proposalId: string, layers: MotifLayerRef[] = []): { publication: PublicationView; motif_id: string; updates: MotifRebindEntry[] } {
        const { state, proposal } = this.pending(id, proposalId);
        if (!existsSync(this.proposalDir(id)))
            throw new MotifRefusal('The proposed package is gone; ask for a new proposal', { error: 'ProposalNotFound', proposal_id: proposalId });
        let finalId: string, version: number, draftId = id;
        if ('new_id' in proposal.target) {
            finalId = proposal.target.new_id;
            const legacy = finalId === id;
            if (this.store.publishedIds().includes(finalId) || BUILTIN_IDS.includes(finalId) || (!legacy && this.store.listDraftIds().includes(finalId)))
                throw new MotifRefusal(`'${finalId}' was published by someone else since this proposal; reject it and ask for a new one`, { error: 'MotifIdTaken', id: finalId });
            version = 1;
            if (legacy)
                draftId = this.rekey(id, state);
        }
        else {
            finalId = proposal.target.id;
            const prev = this.store.listManifests().find(m => m.id === finalId);
            if (!prev || prev.version !== proposal.target.version)
                throw new MotifRefusal(`'${finalId}' changed since this proposal (now ${prev ? `version ${prev.version}` : 'deleted'}); reject it and ask for a new one`, { error: 'VersionConflict', id: finalId, current_version: prev?.version ?? null });
            version = prev.version + 1;
        }
        const dir = this.proposalDir(draftId);
        // Trial layers on the draft — under its old id when it was just moved,
        // which is the publication's id now — rebind to the publication.
        const { updates, rebound } = this.writePublication(draftId, state, readMotifDirectory(dir), proposal.revision, finalId, version, layers);
        state.proposal = { ...proposal, state: 'approved', decided_at: new Date().toISOString(), version, rebound,
            ...(draftId !== id ? { renamed_draft: { from: id, to: draftId } } : {}) };
        this.save(draftId, state);
        rmSync(dir, { recursive: true, force: true });
        return { publication: view(state.proposal), motif_id: finalId, updates };
    }
    /** Move a draft whose id is its name's to `<id>-draft`, so its first
     *  publication can take `<id>`: its package (re-stamped with the new id),
     *  its state record and its frozen proposal. A linked draft keeps its
     *  folder. Refuses, changing nothing, when `<id>-draft` is held. */
    private rekey(id: string, state: DraftState): string {
        const next = `${id}-draft`;
        const pending = this.pendingNewIds(id).get(next);
        const holder: [string, string] | null = BUILTIN_IDS.includes(next) ? ['builtin', 'a built-in Motif']
            : this.store.publishedIds().includes(next) ? ['installed', `the installed Motif '${next}'`]
                : this.store.listDraftIds().includes(next) ? ['draft', `the draft '${next}'`]
                    : pending ? ['proposal', `a pending proposal from the draft '${pending}'`] : null;
        if (holder)
            throw new MotifRefusal(`To publish '${id}', its draft must move to '${next}', which is taken by ${holder[1]}; rename or delete that one, then approve again`, { error: 'DraftIdTaken', id: next, holder: holder[0] });
        replacePackage(this.draftDir(next), normalize(this.store.packageFiles(id), next).files);
        renameSync(this.proposalDir(id), this.proposalDir(next));
        this.save(next, state);
        rmSync(this.draftDir(id), { recursive: true, force: true });
        this.store.revisions.forget(this.draftDir(id));
        rmSync(this.stateFile(id), { force: true });
        return next;
    }
    /** The user's rejection: the draft stays, with their note. */
    reject(id: string, proposalId: string, note?: string): PublicationView {
        const { state, proposal } = this.pending(id, proposalId);
        const text = typeof note === 'string' ? note.trim().slice(0, NOTE_CHARS) : '';
        state.proposal = { ...proposal, state: 'rejected', decided_at: new Date().toISOString(), ...(text ? { note: text } : {}) };
        this.save(id, state);
        rmSync(this.proposalDir(id), { recursive: true, force: true });
        return view(state.proposal);
    }
    /** The app's own Install / Update / Save as new: the user publishes
     *  directly. A first publication takes a free id from the name. */
    publish(id: string, expected: string, targetId?: string, expectedVersion?: number, layers: MotifLayerRef[] = []) {
        const { info, state } = this.publishable(id, expected, 'installed');
        const replaces = this.replaceTarget(state, targetId, expectedVersion);
        if (replaces && state.publication?.id === replaces.id && state.publication.revision === expected && state.publication.version === replaces.version) {
            const manifest = this.store.listManifests().find(m => m.id === replaces.id)!;
            return { motif_id: replaces.id, version: replaces.version, revision: expected, updates: buildRebindUpdates(layers, id, manifest) };
        }
        const finalId = replaces?.id ?? assignUniqueId(info.manifest.name, [...this.allIds(), ...this.pendingNewIds(id).keys()]);
        const version = replaces ? replaces.version + 1 : 1;
        const { updates } = this.writePublication(id, state, this.store.packageFiles(id), expected, finalId, version, layers);
        this.save(id, state);
        return { motif_id: finalId, version, revision: expected, updates };
    }
    /** Every pending proposal, as the Motif panel's cards show them. */
    proposals(layers: MotifLayerRef[] = []): ProposalCard[] {
        const out: ProposalCard[] = [];
        for (const id of this.store.listDraftIds()) {
            const p = this.state(id).proposal;
            if (p?.state !== 'awaiting_approval')
                continue;
            const preview = this.store.getMotif(proposalPreviewId(id));
            if (!preview)
                continue;
            const targetId = 'id' in p.target ? p.target.id : null;
            out.push({ ...view(p), motif_id: id, proposed_at: p.proposed_at, preview_id: proposalPreviewId(id), manifest: preview.manifest,
                diff: 'id' in p.target ? this.diff(id, p.target) : null,
                rebinds: layers.filter(l => l.motifId === id || l.motifId === targetId).map(l => l.layerId) });
        }
        return out;
    }
    /** Files and props schema of a proposal against the version it replaces.
     *  Both sides are normalised under the target's id and version, so only a
     *  real change differs. */
    private diff(id: string, target: { id: string; version: number }): ProposalDiff | null {
        const current = this.store.packageFiles(target.id);
        const before = new Map(current.map(f => [f.path, f.bytes]));
        let after: Map<string, Buffer>, next: Manifest;
        try {
            const pkg = normalize(readMotifDirectory(this.proposalDir(id)), target.id, target.version);
            after = new Map(pkg.files.map(f => [f.path, f.bytes]));
            next = pkg.manifest;
        }
        catch {
            return null;
        }
        const prev = this.store.getMotif(target.id)?.manifest;
        const keys = (o: object | undefined) => Object.keys(o ?? {});
        const was = prev?.props_schema ?? {};
        return {
            files: { added: [...after.keys()].filter(k => !before.has(k)).sort(), removed: [...before.keys()].filter(k => !after.has(k)).sort(),
                changed: [...after.keys()].filter(k => before.has(k) && !before.get(k)!.equals(after.get(k)!)).sort() },
            props: { added: keys(next.props_schema).filter(k => !(k in was)), removed: keys(was).filter(k => !(k in next.props_schema)),
                changed: keys(next.props_schema).filter(k => k in was && JSON.stringify(was[k]) !== JSON.stringify(next.props_schema[k])) },
        };
    }
    delete(id: string) {
        safeId(id);
        if (BUILTIN_IDS.includes(id))
            throw new Error('Cannot delete a built-in Motif');
        if (!this.store.getMotif(id) && !this.store.getDraft(id))
            throw new Error('Unknown Motif: ' + id);
        const { directory } = this.state(id);
        this.store.deleteUserMotif(id);
        rmSync(this.proposalDir(id), { recursive: true, force: true });
        rmSync(this.stateFile(id), { force: true });
        this.store.revisions.forget(this.proposalDir(id));
        if (directory)
            this.store.revisions.forget(directory);
    }
}
