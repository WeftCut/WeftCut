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
import { PackageSource, type PackageListing, type PackageSnapshot } from './packageSource';
import { LINEAGE_FILE, MotifLineage } from './lineage';

/** An older release's app-wide drafts, left in the library folder untouched
 *  and unlisted; only the v5 upgrade reads them (`legacyResolve.ts`). */
export const DRAFTS_DIR = "drafts";
/** Frozen packages of proposed publications, one per proposal id
 *  (`publications.ts`), served under `proposalPreviewId(<proposal id>)`. */
export const PROPOSALS_DIR = ".proposals";

/** Reject an id segment that could traverse or escape. */
function safeSeg(seg: string): string {
  if (motifFileSegments(seg)?.length !== 1) {
    throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

/** The store layout this build writes, recorded in `<root>/.format`: 1 has no
 *  private file in any package (ADR 0171); 2 keeps every installed version in
 *  `<id>/v<n>/` (ADR 0172). */
const STORE_FORMAT = 2;
const FORMAT_FILE = ".format";

/** A version written aside in `<id>/` before it is renamed into place. */
const STAGE_PREFIX = ".stage-";
/** A proposal's package written aside in `.proposals/` (`replacePackage`):
 *  `<key>.stage-<uuid>`. */
const PROPOSAL_STAGE = /\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** On-disk library of user Motifs rooted at `<userData>/motifs/`: installed
 *  Motifs, each version in `<id>/v<n>/`, and the frozen packages of proposed
 *  publications in `.proposals/`. */
export class UserMotifStore {
  /** Also keeps the records of the folders a v5 upgrade reads
   *  (`legacyResolve.ts`) and of project Motif folders. */
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

  /** Whether `id` can name an installed Motif's folder. */
  private libraryId(id: string): boolean {
    return id !== DRAFTS_DIR && !id.startsWith(".") && motifFileSegments(id)?.length === 1;
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
    if (!this.libraryId(id)) return null;
    for (const n of this.versionNumbers(id)) {
      const rel = `${id}/${versionDirName(n)}`;
      if (hasMotifFile(this._root, `${rel}/index.html`)) return rel;
    }
    return null;
  }

  /** The current version of installed `id` from one read: its files,
   *  revision and version; null when `id` is not installed. */
  installedSnapshot(id: string): (PackageSnapshot & { version: number }) | null {
    const rel = this.currentRel(id);
    return rel ? { ...this.source.snapshot(path.join(this._root, rel)), version: versionOfDir(rel.slice(id.length + 1))! } : null;
  }

  /** The current version of installed `id` as `describe` lists it; null
   *  when `id` is not installed, throws when it is no package. */
  installedListing(id: string): PackageListing | null {
    const rel = this.currentRel(id);
    if (!rel) return null;
    const { html, revision, paths } = this.source.listing(path.join(this._root, rel));
    return { html, revision, paths };
  }

  /** The version number and revision of installed `id`'s current version,
   *  its files read only when they changed since its revision was recorded;
   *  null when `id` is not installed. */
  installedHead(id: string): { version: number; revision: string } | null {
    const rel = this.currentRel(id);
    if (!rel) return null;
    return { version: versionOfDir(rel.slice(id.length + 1))!, revision: this.source.listing(path.join(this._root, rel)).revision };
  }

  /** A file of installed `id`'s current version. */
  installedFile(id: string, rel: string): Buffer | null {
    if (!motifFileSegments(rel)) return null;
    const current = this.currentRel(id);
    return current ? readMotifFile(this._root, `${current}/${rel}`) : null;
  }

  /** The manifest of installed `id`'s current version; null when it is not
   *  installed or its page has no island. */
  installedManifest(id: string): Manifest | null {
    const html = this.installedFile(id, "index.html");
    if (!html) return null;
    try { return parseManifestIsland(html.toString("utf8")); } catch { return null; }
  }

  /** The folder of proposal `key`'s frozen package. */
  proposalDir(key: string): string { return path.join(this._root, PROPOSALS_DIR, safeSeg(key)); }

  private proposalRel(key: string): string | null {
    if (motifFileSegments(key)?.length !== 1) return null;
    const rel = `${PROPOSALS_DIR}/${key}`;
    return hasMotifFile(this._root, `${rel}/index.html`) ? rel : null;
  }

  /** Proposal `key`'s frozen package as `describe` lists it; null when it
   *  has none, throws when it is no package. */
  proposalListing(key: string): PackageListing | null {
    const rel = this.proposalRel(key);
    if (!rel) return null;
    const { html, revision, paths } = this.source.listing(path.join(this._root, rel));
    return { html, revision, paths };
  }

  /** A file of proposal `key`'s frozen package. */
  proposalFile(key: string, rel: string): Buffer | null {
    const pkg = this.proposalRel(key);
    return pkg && motifFileSegments(rel) ? readMotifFile(this._root, `${pkg}/${rel}`) : null;
  }

  /** Proposal `key`'s frozen files from one read, with their revision. */
  proposalSnapshot(key: string): PackageSnapshot | null {
    const rel = this.proposalRel(key);
    return rel ? this.source.snapshot(path.join(this._root, rel)) : null;
  }

  /** Brings a store an older release wrote to this build's layout, once: the
   *  marker keeps a later launch from treating files written since as old.
   *  Then removes the staging a crash left mid-write. Runs at launch, before
   *  anything reads or writes the store. */
  upgrade(): void {
    const marker = path.join(this._root, FORMAT_FILE);
    let format = 0;
    try { format = Number(readFileSync(marker, "utf8").trim()) || 0; } catch { /* format 0 */ }
    if (format < STORE_FORMAT) {
      if (format < 1) this.removeLegacyTargets();
      if (!this.versionLegacyPackages()) return;
      try {
        mkdirSync(this._root, { recursive: true });
        writeFileSync(marker, String(STORE_FORMAT));
      } catch { /* upgraded again at the next launch */ }
    }
    this.removeAbandonedStaging();
  }

  /** The staging folders of writes a crash interrupted: a version's in
   *  `<id>/` (`addVersion`) and a proposal's in `.proposals/`
   *  (`replacePackage`); no read lists them. Only in this build's layout:
   *  before the upgrade, `<id>/` is an older release's package, and its
   *  files are the author's. */
  private removeAbandonedStaging(): void {
    const remove = (dir: string, abandoned: (name: string) => boolean) => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (!abandoned(name)) continue;
        try { rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* removed at a later launch */ }
      }
    };
    for (const id of this.packageDirNames()) remove(path.join(this._root, id), name => name.startsWith(STAGE_PREFIX));
    remove(path.join(this._root, PROPOSALS_DIR), name => PROPOSAL_STAGE.test(name));
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

  /** Format 0 kept a package's Update target as a `target` file inside it,
   *  hidden from every read; the file leaves every package, drafts included,
   *  so a package holds only its own files. A file that cannot be removed
   *  stays, as an ordinary file of its package. */
  private removeLegacyTargets(): void {
    const drafts = path.join(this._root, DRAFTS_DIR);
    let draftDirs: string[] = [];
    try { draftDirs = readdirSync(drafts).map(name => path.join(drafts, name)); } catch { /* none */ }
    for (const dir of [...draftDirs, ...this.packageDirNames().map(name => path.join(this._root, name))]) {
      const file = path.join(dir, "target");
      try {
        if (!statSync(file).isFile()) continue;
        rmSync(file);
        this.revisions.forget(dir);
      } catch { /* left in place: see above */ }
    }
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
    if (!this.libraryId(id)) throw new Error(`Invalid Motif id: ${JSON.stringify(id)}`);
    const library = path.join(this._root, id);
    const dir = path.join(library, versionDirName(version));
    if (versionOfDir(versionDirName(version)) !== version) throw new Error(`Invalid Motif version: ${version}`);
    for (const file of files) {
      if (!motifFileSegments(file.path)) throw new Error(`Invalid Motif asset path: ${file.path}`);
    }
    mkdirSync(library, { recursive: true });
    if (existsSync(dir)) throw new Error(`Version ${version} of '${id}' already exists`);
    const staging = path.join(library, STAGE_PREFIX + randomUUID());
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

  /** Moves installed `id` and every version of it to the system trash. A
   *  folder the trash refuses stays where it is, and the error is thrown:
   *  nothing is ever removed for good. */
  async trashMotif(id: string): Promise<void> {
    if (!this.libraryId(id)) throw new Error(`Invalid Motif id: ${JSON.stringify(id)}`);
    const library = path.join(this._root, id);
    const versions = this.versionNumbers(id).map(n => path.join(library, versionDirName(n)));
    if (!existsSync(library)) return;
    try { await this.trash(library); } catch (error) {
      throw new Error(`Could not move “${id}” to the trash: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const v of versions) this.revisions.forget(v);
    this.lineage.forget(id);
  }

  publishedIds(): string[] {
    return this.listManifests().map((m) => m.id);
  }

  /** The root's directories that may hold an installed Motif: not an older
   *  release's drafts directory, nor the store's own dot-directories. */
  private packageDirNames(): string[] {
    let entries: string[];
    try { entries = readdirSync(this._root); } catch { return []; }
    return entries.filter(name => {
      if (name === DRAFTS_DIR || name.startsWith(".")) return false;
      try { return statSync(path.join(this._root, name)).isDirectory(); } catch { return false; }
    });
  }

  /** Every installed user manifest, id-sorted; skips broken packages. */
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
