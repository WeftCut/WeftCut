import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, rmSync, renameSync, cpSync,
} from "node:fs";
import path from "node:path";
import { parseManifestIsland, type Manifest } from "../../shared/motifs/catalog";
import { hasMotifFile, motifFileSegments, readMotifFile, readMotifDirectory, sameStamps, stampMotifDirectory, type MotifFile } from './packageFiles';
import { packageContentHash } from './contentHash';
import { PackageRevisions } from './packageRevisions';
import { MotifError } from '../../shared/motifs/errors';

export const DRAFTS_DIR = "drafts";
/** Frozen packages of pending publications, one per draft (`workspace.ts`). */
export const PROPOSALS_DIR = ".proposals";
/** The id a pending publication's frozen package is served and captured
 *  under: `<draft id>--proposal`. `sanitizeId` never emits `--`, so no
 *  library or draft id can take this form. */
const PROPOSAL_SUFFIX = "--proposal";
export function proposalPreviewId(draftId: string): string { return draftId + PROPOSAL_SUFFIX; }
export function isProposalPreviewId(id: string): boolean { return id.endsWith(PROPOSAL_SUFFIX); }

/** Reject an id segment that could traverse or escape. */
function safeSeg(seg: string): string {
  if (motifFileSegments(seg)?.length !== 1) {
    throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

type MotifSource = { manifest: Manifest; html: string };

/** One package as the catalog lists it: its page, its revision and the paths
 *  of its files. */
export interface PackageListing { html: string; revision: string; paths: string[] }

/** A capture host's hold on a pinned revision snapshot; `release` is idempotent. */
export interface PinnedPackage { release(): void }

/** Snapshots no host holds that stay for reuse; held ones never leave. */
const UNHELD_SNAPSHOTS = 2;

/** On-disk store of user Motifs rooted at `<userData>/motifs/`. */
export class UserMotifStore {
  /** Revision snapshots by `id/revision`, oldest first, with their holders. */
  private pinned = new Map<string, { files: Map<string, Buffer>; holders: number }>();
  /** `revisions` also keeps the linked directories' records (`workspace.ts`). */
  constructor(private readonly _root: string, readonly revisions = new PackageRevisions()) {}

  root(): string { return this._root; }
  assertRenderable(id:string):void {
    if(motifFileSegments(id)?.length!==1)return;
    const file=path.join(this._root,'.workspaces',id+'.json');
    if(existsSync(file)){
      const diagnostic=JSON.parse(readFileSync(file,'utf8')).diagnostic;
      if(diagnostic)throw new MotifError('content','Motif working directory is invalid: '+diagnostic);
    }
  }
  private draftsRoot(): string { return path.join(this._root, DRAFTS_DIR); }

  /** Choose one complete package; never fill missing published assets from a draft. */
  private packageRel(id: string): string | null {
    if (id === DRAFTS_DIR || motifFileSegments(id)?.length !== 1) return null;
    if (isProposalPreviewId(id)) {
      const rel = `${PROPOSALS_DIR}/${id.slice(0, -PROPOSAL_SUFFIX.length)}`;
      return hasMotifFile(this._root, `${rel}/index.html`) ? rel : null;
    }
    for (const rel of [id, `${DRAFTS_DIR}/${id}`]) {
      if (hasMotifFile(this._root, `${rel}/index.html`)) return rel;
    }
    return null;
  }

  /** The selected package's files from one read, with their revision; null
   *  when `id` has no package. */
  packageSnapshot(id: string): { files: MotifFile[]; revision: string } | null {
    const rel = this.packageRel(id);
    return rel ? this.snapshot(path.join(this._root, rel)) : null;
  }

  /** The bytes are hashed only when their stamp has no record; a read that a
   *  write crossed is hashed and not recorded. */
  private snapshot(dir: string): { files: MotifFile[]; revision: string } {
    const { files, stamp } = this.revisions.read(dir);
    const known = stamp && this.revisions.lookup(dir, stamp);
    if (known && 'revision' in known) return { files, revision: known.revision };
    const revision = packageContentHash(files);
    if (stamp) this.revisions.record(dir, stamp, { revision });
    return { files, revision };
  }

  private listing(dir: string): PackageListing {
    const stamp = this.revisions.stamp(dir);
    const known = this.revisions.lookup(dir, stamp);
    if (known && 'revision' in known) {
      const html = readMotifFile(dir, 'index.html');
      // The page is the stamped one only if nothing moved while it was read.
      if (html && sameStamps(stamp.files, stampMotifDirectory(dir)))
        return { html: html.toString('utf8'), revision: known.revision, paths: stamp.files.map(f => f.path) };
    }
    const { files, revision } = this.snapshot(dir);
    return { html: files.find(f => f.path === 'index.html')!.bytes.toString('utf8'), revision, paths: files.map(f => f.path) };
  }

  /** The selected package of `id`, read in full only when its files changed
   *  since its revision was recorded. Null when there is none; throws when
   *  its directory or its manifest island is not a package's. */
  describe(id: string): PackageListing | null {
    const rel = this.packageRel(id);
    return rel ? this.listing(path.join(this._root, rel)) : null;
  }

  /** The revision of the draft package itself, whatever is published under
   *  its id; null when it has none or it does not read as a package. */
  draftRevision(draftId: string): string | null {
    try {
      const dir = path.join(this.draftsRoot(), safeSeg(draftId));
      return hasMotifFile(dir, 'index.html') ? this.listing(dir).revision : null;
    } catch { return null; }
  }

  readFile(id: string, rel: string): Buffer | null {
    const revision = /^\.revisions\/([0-9a-f]{64})\/(.+)$/.exec(rel);
    if (revision) return this.pinned.get(`${id}/${revision[1]}`)?.files.get(revision[2]!) ?? null;
    if (!motifFileSegments(rel) || rel.toLowerCase() === 'target') return null;
    const pkg = this.packageRel(id);
    return pkg ? readMotifFile(this._root, `${pkg}/${rel}`) : null;
  }

  /** Pins the revision's files for a capture host, which serves its page and
   * companion URLs from the revision directory, so a source save cannot mix
   * old HTML with new assets. A held snapshot stays until every host holding
   * it releases it: a host still loading its page must not lose it to a later
   * pin. Null when the Motif is gone. */
  pinPackage(id: string, revision: string): PinnedPackage | null {
    const key = `${id}/${revision}`;
    let snapshot = this.pinned.get(key);
    if (snapshot) this.pinned.delete(key);
    else {
      if (!this.getMotif(id)) return null;
      const read = this.snapshot(path.join(this._root, this.packageRel(id)!));
      if (read.revision !== revision) throw new Error('Motif revision changed before capture; refresh the catalog');
      snapshot = { files: new Map(read.files.map(f => [f.path, f.bytes])), holders: 0 };
    }
    snapshot.holders++;
    // Most recently pinned last.
    this.pinned.set(key, snapshot);
    const held = snapshot;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        held.holders--;
        this.trimPinned();
      },
    };
  }

  private trimPinned(): void {
    let unheld = 0;
    for (const s of this.pinned.values()) if (s.holders === 0) unheld++;
    for (const [key, s] of this.pinned) {
      if (unheld <= UNHELD_SNAPSHOTS) return;
      if (s.holders > 0) continue;
      this.pinned.delete(key);
      unheld--;
    }
  }

  packageFiles(id: string): MotifFile[] {
    const rel = this.packageRel(id);
    return rel ? readMotifDirectory(path.join(this._root, rel)) : [];
  }

  /** Presence in the selected package, with the same confinement as reads. */
  hasFile(id: string, rel: string): boolean {
    return this.readFile(id, rel) !== null;
  }

  readHtml(id: string): string | null {
    const b = this.readFile(id, "index.html");
    return b ? b.toString("utf8") : null;
  }

  getMotif(id: string): MotifSource | null {
    if (id === DRAFTS_DIR) return null;
    const html = this.readHtml(id);
    if (html == null) return null;
    try { return { manifest: parseManifestIsland(html), html }; } catch { return null; }
  }

  writeDraft(draftId: string, html: string): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), html);
  }

  /** New drafts copy a validated snapshot, preserving relative asset URLs. */
  writeDraftPackage(draftId: string, html: string, files: readonly MotifFile[]): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    if (existsSync(dir)) throw new Error(`draft '${draftId}' already exists`);
    for (const file of files) {
      if (!motifFileSegments(file.path)) throw new Error(`Invalid Motif asset path: ${file.path}`);
    }
    try {
      this.writeDraft(draftId, html);
      for (const file of files) {
        if (file.path === 'index.html' || file.path.toLowerCase() === 'target') continue;
        const dest = path.join(dir, ...file.path.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, file.bytes);
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  writeDraftTarget(draftId: string, targetId: string): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "target"), targetId);
  }

  readDraftTarget(draftId: string): string | null {
    let seg: string;
    try { seg = safeSeg(draftId); } catch { return null; }
    try {
      const t = readFileSync(path.join(this.draftsRoot(), seg, "target"), "utf8").trim();
      return t === "" ? null : t;
    } catch { return null; }
  }

  listDraftIds(): string[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.draftsRoot()).filter((name) =>
        statSync(path.join(this.draftsRoot(), name)).isDirectory(),
      );
    } catch { return []; }
    return entries.sort();
  }

  listDrafts(): MotifSource[] {
    return this.listDraftIds()
      .map((id) => this.getDraft(id))
      .filter((m): m is MotifSource => m !== null);
  }

  getDraft(draftId: string): MotifSource | null {
    let seg: string;
    try { seg = safeSeg(draftId); } catch { return null; }
    let html: string;
    try { html = readFileSync(path.join(this.draftsRoot(), seg, "index.html"), "utf8"); }
    catch { return null; }
    try { return { manifest: parseManifestIsland(html), html }; } catch { return null; }
  }

  /** Move `<root>/drafts/<draftId>/` → `<root>/<finalId>/`, overwriting. */
  installDraft(draftId: string, finalId: string): void {
    mkdirSync(this._root, { recursive: true });
    const from = path.join(this.draftsRoot(), safeSeg(draftId));
    const to = path.join(this._root, safeSeg(finalId));
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    this.revisions.forget(from);
    this.revisions.forget(to);
    try {
      renameSync(from, to);
    } catch {
      // Cross-device fallback: copy then remove the source.
      try {
        cpSync(from, to, { recursive: true });
      } catch (copyErr) {
        rmSync(to, { recursive: true, force: true });
        throw copyErr;
      }
      rmSync(from, { recursive: true, force: true });
    }
  }

  /** Remove published + draft dirs for an id. Idempotent. */
  deleteUserMotif(id: string): void {
    const safeId = safeSeg(id);
    const published = path.join(this._root, safeId);
    if (existsSync(published)) rmSync(published, { recursive: true, force: true });
    const draft = path.join(this.draftsRoot(), safeId);
    if (existsSync(draft)) rmSync(draft, { recursive: true, force: true });
    this.revisions.forget(published);
    this.revisions.forget(draft);
  }

  publishedIds(): string[] {
    return this.listManifests().map((m) => m.id);
  }

  /** Every installed user manifest, id-sorted; skips drafts + broken. */
  listManifests(): Manifest[] {
    let entries: string[];
    try { entries = readdirSync(this._root); } catch { return []; }
    const out: Manifest[] = [];
    for (const name of entries) {
      const p = path.join(this._root, name);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      if (name === DRAFTS_DIR) continue;
      let html: string;
      try { html = readFileSync(path.join(p, "index.html"), "utf8"); } catch { continue; }
      try { out.push(parseManifestIsland(html)); }
      catch { /* skip broken island */ }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}
