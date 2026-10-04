import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, rmSync, renameSync, cpSync,
} from "node:fs";
import path from "node:path";
import { parseManifestIsland, type Manifest } from "../../shared/motifs/catalog";
import { motifFileSegments, readMotifFile, readMotifDirectory, type MotifFile } from './packageFiles';
import { motifContentHash } from './contentHash';

export const DRAFTS_DIR = "drafts";

/** Reject an id segment that could traverse or escape. */
function safeSeg(seg: string): string {
  if (motifFileSegments(seg)?.length !== 1) {
    throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

type MotifSource = { manifest: Manifest; html: string };

/** On-disk store of user Motifs rooted at `<userData>/motifs/`. */
export class UserMotifStore {
  private pinned = new Map<string, Map<string, Buffer>>();
  constructor(private readonly _root: string) {}

  root(): string { return this._root; }
  assertRenderable(id:string):void {
    if(motifFileSegments(id)?.length!==1)return;
    const file=path.join(this._root,'.workspaces',id+'.json');
    if(existsSync(file)){
      const diagnostic=JSON.parse(readFileSync(file,'utf8')).diagnostic;
      if(diagnostic)throw new Error('Motif working directory is invalid: '+diagnostic);
    }
  }
  private draftsRoot(): string { return path.join(this._root, DRAFTS_DIR); }

  /** Choose one complete package; never fill missing published assets from a draft. */
  private packageRel(id: string): string | null {
    if (id === DRAFTS_DIR || motifFileSegments(id)?.length !== 1) return null;
    for (const rel of [id, `${DRAFTS_DIR}/${id}`]) {
      if (readMotifFile(this._root, `${rel}/index.html`)) return rel;
    }
    return null;
  }

  readFile(id: string, rel: string): Buffer | null {
    const revision = /^\.revisions\/([0-9a-f]{64})\/(.+)$/.exec(rel);
    if (revision) return this.pinned.get(`${id}/${revision[1]}`)?.get(revision[2]!) ?? null;
    if (!motifFileSegments(rel) || rel.toLowerCase() === 'target') return null;
    const pkg = this.packageRel(id);
    return pkg ? readMotifFile(this._root, `${pkg}/${rel}`) : null;
  }

  /** Two navigation snapshots bound retained memory; companion URLs use the
   * revision directory so a source save cannot mix old HTML with new assets. */
  pinPackage(id:string, revision:string): boolean {
    const key=`${id}/${revision}`;
    if(this.pinned.has(key))return true;
    const source=this.getMotif(id);
    if(!source)return false;
    const files=this.packageFiles(id);
    if(motifContentHash(source.manifest,source.html,files)!==revision)throw new Error('Motif revision changed before capture; refresh the catalog');
    this.pinned.set(key,new Map(files.map(f=>[f.path,f.bytes])));
    while(this.pinned.size>2)this.pinned.delete(this.pinned.keys().next().value!);
    return true;
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
