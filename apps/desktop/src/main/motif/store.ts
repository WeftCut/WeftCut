import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, rmSync, renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseManifestIsland, type Manifest } from "../../shared/motifs/catalog";
import { hasMotifFile, motifFileSegments, readMotifFile, readMotifDirectory, stampMotifFile, type MotifFile } from './packageFiles';
import { packageContentHash } from './contentHash';
import { PackageRevisions } from './packageRevisions';
import { PackageSource, type PackageListing, type PackageSnapshot, type PinnedPackage } from './packageSource';
import { LINEAGE_FILE, MotifLineage } from './lineage';
import { MotifError } from '../../shared/motifs/errors';
import { isProposalPreviewId, proposalOfHost } from '../../shared/motifs/projectMotifs';

export const DRAFTS_DIR = "drafts";
/** Frozen packages of pending publications, one per draft (`workspace.ts`),
 *  served under `proposalPreviewId(<draft id>)`. */
export const PROPOSALS_DIR = ".proposals";

/** Reject an id segment that could traverse or escape. */
function safeSeg(seg: string): string {
  if (motifFileSegments(seg)?.length !== 1) {
    throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

type MotifSource = { manifest: Manifest; html: string };

/** The store layout this build writes, recorded in `<root>/.format`: 1 has no
 *  private file in any package (ADR 0171); 2 keeps every installed version in
 *  `<id>/v<n>/` (ADR 0172). */
const STORE_FORMAT = 2;
const FORMAT_FILE = ".format";

/** An installed version's directory: `v` and the manifest version it holds. */
export function versionDirName(version: number): string { return `v${version}`; }
/** The version a library directory name holds, or null when it is no version's. */
export function versionOfDir(name: string): number | null {
  const match = /^v([1-9][0-9]{0,8})$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** One saved version of an installed Motif, as its history lists it. */
export interface MotifVersion { version: number; revision: string; saved_at: string }

/** Moves a file or folder to the system trash; rejects when it cannot. */
export type Trash = (absPath: string) => Promise<void>;

/** On-disk store of user Motifs rooted at `<userData>/motifs/`. */
export class UserMotifStore {
  /** Also keeps the linked directories' records (`workspace.ts`). */
  readonly revisions: PackageRevisions;
  private readonly source: PackageSource;
  readonly lineage: MotifLineage;
  private readonly trash: Trash;
  /** Without `trash`, nothing can be deleted: a delete never falls back to
   *  removing files for good. */
  constructor(
    private readonly _root: string,
    options: { revisions?: PackageRevisions; lineage?: MotifLineage; trash?: Trash } = {},
  ) {
    this.revisions = options.revisions ?? new PackageRevisions();
    this.source = new PackageSource(this.revisions, files => packageContentHash(files));
    this.lineage = options.lineage ?? new MotifLineage(path.join(_root, LINEAGE_FILE));
    this.trash = options.trash ?? (async () => { throw new Error('No system trash is available'); });
  }

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
    const proposal = proposalOfHost(id);
    if (proposal !== null) {
      const rel = `${PROPOSALS_DIR}/${proposal}`;
      return hasMotifFile(this._root, `${rel}/index.html`) ? rel : null;
    }
    const current = this.currentRel(id);
    if (current) return current;
    const draft = `${DRAFTS_DIR}/${id}`;
    return hasMotifFile(this._root, `${draft}/index.html`) ? draft : null;
  }

  /** The version numbers `<id>/` holds, highest first, packaged or not. */
  private versionNumbers(id: string): number[] {
    let names: string[];
    try { names = readdirSync(path.join(this._root, id)); } catch { return []; }
    return names.map(versionOfDir).filter((n): n is number => n !== null).sort((a, b) => b - a);
  }

  /** The current version of installed `id`, store-relative: its highest
   *  `v<n>` holding an index.html. Every read of an installed Motif resolves
   *  through here, so an older version is never served as the Motif. */
  private currentRel(id: string): string | null {
    for (const n of this.versionNumbers(id)) {
      const rel = `${id}/${versionDirName(n)}`;
      if (hasMotifFile(this._root, `${rel}/index.html`)) return rel;
    }
    return null;
  }

  /** The lineage of the package `id` selects, as `read` and `export` see it
   *  (a proposal's preview is its draft's); null when `id` has none. An
   *  installed Motif's is keyed by its id, one lineage for all its versions. */
  lineageOf(id: string): string | null {
    const rel = this.packageRel(id);
    if (!rel) return null;
    if (isProposalPreviewId(id)) return this.lineage.of(`${DRAFTS_DIR}/${proposalOfHost(id)}`);
    return this.lineage.of(rel === `${DRAFTS_DIR}/${id}` ? rel : id);
  }

  /** The selected package's files from one read, with their revision; null
   *  when `id` has no package. */
  packageSnapshot(id: string): PackageSnapshot | null {
    const rel = this.packageRel(id);
    return rel ? this.source.snapshot(path.join(this._root, rel)) : null;
  }

  /** The current version of installed `id` from one read: its files,
   *  revision and version; null when `id` is not installed. Drafts and
   *  proposals are not the library. */
  installedSnapshot(id: string): (PackageSnapshot & { version: number }) | null {
    if (id === DRAFTS_DIR || motifFileSegments(id)?.length !== 1) return null;
    const rel = this.currentRel(id);
    return rel ? { ...this.source.snapshot(path.join(this._root, rel)), version: versionOfDir(rel.slice(id.length + 1))! } : null;
  }

  /** The selected package of `id`, read in full only when its files changed
   *  since its revision was recorded. Null when there is none; throws when
   *  its directory or its manifest island is not a package's. */
  describe(id: string): PackageListing | null {
    const rel = this.packageRel(id);
    if (!rel) return null;
    const { html, revision, paths } = this.source.listing(path.join(this._root, rel));
    return { html, revision, paths };
  }

  /** The revision of the draft package itself, whatever is published under
   *  its id; null when it has none or it does not read as a package. */
  draftRevision(draftId: string): string | null {
    try {
      const dir = path.join(this.draftsRoot(), safeSeg(draftId));
      return hasMotifFile(dir, 'index.html') ? this.source.listing(dir).revision : null;
    } catch { return null; }
  }

  readFile(id: string, rel: string): Buffer | null {
    const revision = /^\.revisions\/([0-9a-f]{64})\/(.+)$/.exec(rel);
    if (revision) return this.source.pinnedFile(id, revision[1]!, revision[2]!);
    if (!motifFileSegments(rel)) return null;
    const pkg = this.packageRel(id);
    return pkg ? readMotifFile(this._root, `${pkg}/${rel}`) : null;
  }

  /** Pins the revision's files for a capture host, which serves its page and
   * companion URLs from the revision directory (`PackageSource.pin`). Null
   * when the Motif is gone. */
  pinPackage(id: string, revision: string): PinnedPackage | null {
    return this.source.pin(id, revision, () => this.getMotif(id) ? path.join(this._root, this.packageRel(id)!) : null);
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
        if (file.path === 'index.html') continue;
        const dest = path.join(dir, ...file.path.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, file.bytes);
      }
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Brings a store an older release wrote to this build's layout, once: the
   *  marker keeps a later launch from treating files written since as old. */
  upgrade(): void {
    const marker = path.join(this._root, FORMAT_FILE);
    let format = 0;
    try { format = Number(readFileSync(marker, "utf8").trim()) || 0; } catch { /* format 0 */ }
    if (format >= STORE_FORMAT) return;
    if (format < 1) this.adoptLegacyTargets();
    if (!this.versionLegacyPackages()) return;
    try {
      mkdirSync(this._root, { recursive: true });
      writeFileSync(marker, String(STORE_FORMAT));
    } catch { /* upgraded again at the next launch */ }
  }

  /** Format 1 kept an installed Motif's one version at `<id>/`; it moves to
   *  `<id>/v<its manifest version>/` (v1 when the manifest does not parse).
   *  A move is three steps through `.versioning-<id>` in the root, and a move
   *  a crash interrupted is finished first. The revision records move with
   *  the files, which keep their stamps. False when a move failed: the upgrade
   *  runs again at the next launch, and until then that Motif is not listed. */
  private versionLegacyPackages(): boolean {
    const PENDING = ".versioning-";
    let names: string[];
    try { names = readdirSync(this._root); } catch { return true; }
    let complete = true;
    const move = (staged: string, id: string) => {
      const library = path.join(this._root, id);
      let version = 1;
      try {
        const declared = parseManifestIsland(readFileSync(path.join(staged, "index.html"), "utf8")).version;
        if (versionOfDir(versionDirName(declared)) === declared) version = declared;
      } catch { /* v1 */ }
      try {
        mkdirSync(library, { recursive: true });
        const dir = path.join(library, versionDirName(version));
        renameSync(staged, dir);
        this.revisions.move(path.join(this._root, id), dir);
      } catch (error) {
        complete = false;
        console.warn(`[motif-store] could not move '${id}' into its version folder`, error);
      }
    };
    for (const name of names) {
      if (name.startsWith(PENDING)) move(path.join(this._root, name), name.slice(PENDING.length));
    }
    for (const id of this.packageDirNames()) {
      const library = path.join(this._root, id);
      if (!hasMotifFile(library, "index.html")) continue;
      const staged = path.join(this._root, PENDING + id);
      try { renameSync(library, staged); } catch (error) {
        complete = false;
        console.warn(`[motif-store] could not move '${id}' into its version folder`, error);
        continue;
      }
      move(staged, id);
    }
    return complete;
  }

  /** Format 0 kept a draft's Update target as a `target` file inside its
   *  package, hidden from every read. A draft's file becomes its `source_id`
   *  (the Motif its Update button offers) unless it has one or a publication;
   *  the file leaves every package, so a package holds only its own files. A
   *  file that cannot be removed stays, as an ordinary file of its package. */
  private adoptLegacyTargets(): void {
    const packages = [
      ...this.listDraftIds().map(id => ({ dir: path.join(this.draftsRoot(), id), draft: id })),
      ...this.packageDirNames().map(name => ({ dir: path.join(this._root, name), draft: null })),
    ];
    for (const { dir, draft } of packages) {
      const file = path.join(dir, "target");
      let target: string;
      try {
        if (!statSync(file).isFile()) continue;
        target = readFileSync(file, "utf8").trim();
      } catch { continue; }
      try {
        if (draft && target && motifFileSegments(target)?.length === 1) {
          const stateFile = path.join(this._root, ".workspaces", `${draft}.json`);
          const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
          if (!state.source_id && !state.publication) {
            mkdirSync(path.dirname(stateFile), { recursive: true });
            writeFileSync(stateFile + ".tmp", JSON.stringify({ ...state, source_id: target }));
            renameSync(stateFile + ".tmp", stateFile);
          }
        }
        rmSync(file);
        this.revisions.forget(dir);
      } catch { /* left in place: see above */ }
    }
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

  /** The number the next version of installed `id` takes: one above every
   *  version directory it has, packaged or not, so none is written over. */
  nextVersion(id: string): number {
    return (this.versionNumbers(safeSeg(id))[0] ?? 0) + 1;
  }

  /** Adds version `version` of installed `id`, which becomes its current
   *  version. Written aside and renamed into place whole, so a reader sees
   *  all of it or none; refuses a version that exists. */
  addVersion(id: string, version: number, files: readonly MotifFile[]): void {
    const library = path.join(this._root, safeSeg(id));
    const dir = path.join(library, versionDirName(version));
    if (versionOfDir(versionDirName(version)) !== version) throw new Error(`Invalid Motif version: ${version}`);
    for (const file of files) {
      if (!motifFileSegments(file.path)) throw new Error(`Invalid Motif asset path: ${file.path}`);
    }
    mkdirSync(library, { recursive: true });
    if (existsSync(dir)) throw new Error(`Version ${version} of '${id}' already exists`);
    const staging = path.join(library, `.stage-${randomUUID()}`);
    try {
      for (const file of files) {
        const dest = path.join(staging, ...file.path.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, file.bytes);
      }
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Every version of installed `id` that reads as a package, newest first.
   *  `saved_at` is when its page was written: a version is never written
   *  again. */
  versions(id: string): MotifVersion[] {
    const out: MotifVersion[] = [];
    for (const version of this.versionNumbers(safeSeg(id))) {
      const dir = path.join(this._root, id, versionDirName(version));
      const page = hasMotifFile(this._root, `${id}/${versionDirName(version)}/index.html`) ? stampMotifFile(dir, 'index.html') : null;
      if (!page) continue;
      try {
        out.push({ version, revision: this.source.listing(dir).revision, saved_at: new Date(Number(BigInt(page.mtimeNs) / 1_000_000n)).toISOString() });
      } catch { /* not a package */ }
    }
    return out;
  }

  /** The files of version `version` of installed `id`; null when it has no
   *  such version. */
  versionFiles(id: string, version: number): MotifFile[] | null {
    const rel = `${safeSeg(id)}/${versionDirName(version)}`;
    if (versionOfDir(versionDirName(version)) !== version || !hasMotifFile(this._root, `${rel}/index.html`)) return null;
    return readMotifDirectory(path.join(this._root, rel));
  }

  /** Moves installed `id`, every version of it, and its draft to the system
   *  trash. A folder the trash refuses stays where it is, and the error is
   *  thrown: nothing is ever removed for good. */
  async trashMotif(id: string): Promise<void> {
    const safeId = safeSeg(id);
    const library = path.join(this._root, safeId);
    const versions = this.versionNumbers(safeId).map(n => path.join(library, versionDirName(n)));
    const draft = path.join(this.draftsRoot(), safeId);
    for (const [dir, forget] of [
      [library, () => { for (const v of versions) this.revisions.forget(v); this.lineage.forget(safeId); }],
      [draft, () => { this.revisions.forget(draft); this.lineage.forget(`${DRAFTS_DIR}/${safeId}`); }],
    ] as const) {
      if (!existsSync(dir)) continue;
      try { await this.trash(dir); } catch (error) {
        throw new Error(`Could not move “${path.relative(this._root, dir)}” to the trash: ${error instanceof Error ? error.message : String(error)}`);
      }
      forget();
    }
  }

  publishedIds(): string[] {
    return this.listManifests().map((m) => m.id);
  }

  /** The root's directories that may hold an installed Motif: not the
   *  drafts directory, nor the store's own dot-directories. */
  private packageDirNames(): string[] {
    let entries: string[];
    try { entries = readdirSync(this._root); } catch { return []; }
    return entries.filter(name => {
      if (name === DRAFTS_DIR || name.startsWith(".")) return false;
      try { return statSync(path.join(this._root, name)).isDirectory(); } catch { return false; }
    });
  }

  /** Every installed user manifest, id-sorted; skips drafts + broken. */
  listManifests(): Manifest[] {
    const out: Manifest[] = [];
    for (const name of this.packageDirNames()) {
      const rel = this.currentRel(name);
      const html = rel && readMotifFile(this._root, `${rel}/index.html`);
      if (!html) continue;
      try { out.push(parseManifestIsland(html.toString("utf8"))); }
      catch { /* skip broken island */ }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}
