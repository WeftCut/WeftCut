import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UserMotifStore, versionDirName, type Trash } from "./store";
import { composeMotifHtml, parseManifestIsland, type Manifest } from "../../shared/motifs/catalog";
import { motifContentHash, packageContentHash } from "./contentHash";
import { readMotifDirectory, type MotifFile } from "./packageFiles";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "motif-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function man(id: string, name: string, version: number): Manifest {
  return { id, name, version, size: [100, 100], default_duration_s: 1, props_schema: {} };
}
const body = "<head></head><body><script>motif.define({setup(){}})</script></body>";
const page = (id: string, name: string, version: number, text = body) => Buffer.from(composeMotifHtml(man(id, name, version), text));

/** Installs the next version of `id`: its page, named `name`, and `files`. */
function install(s: UserMotifStore, id: string, name: string, files: MotifFile[] = []): number {
  const version = s.nextVersion(id);
  s.addVersion(id, version, [{ path: "index.html", bytes: page(id, name, version) }, ...files]);
  return version;
}

/** Every file under `dir`, by relative path, with its bytes. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(at, entry.name), `${prefix}${entry.name}/`);
      else out[prefix + entry.name] = readFileSync(path.join(at, entry.name), "utf8");
    }
  };
  visit(dir, "");
  return out;
}

describe("UserMotifStore drafts", () => {
  it("write_draft → list + get", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", composeMotifHtml(man("d1", "Draft One", 1), body));
    expect(s.listDraftIds()).toEqual(["d1"]);
    expect(s.listManifests()).toEqual([]);
    expect(s.getDraft("d1")?.manifest.id).toBe("d1");
  });
});

describe("UserMotifStore versions", () => {
  it("serves the current version, and never an older version's files", () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo v1", [{ path: "old.txt", bytes: Buffer.from("only in v1") }]);
    install(s, "foo", "Foo v2");
    const current = s.listManifests().find((m) => m.id === "foo")!;
    expect(current.version).toBe(2);
    expect(current.name).toBe("Foo v2");
    expect(s.readHtml("foo")).toContain("Foo v2");
    expect(s.readFile("foo", "old.txt")).toBeNull();
    expect(s.hasFile("foo", "old.txt")).toBe(false);
    expect(s.packageFiles("foo").map((f) => f.path)).toEqual(["index.html"]);
    expect(s.describe("foo")!.revision).toBe(packageContentHash(readMotifDirectory(path.join(root, "foo", "v2"))));
    // The earlier version stays, whole.
    expect(readFileSync(path.join(root, "foo", "v1", "old.txt"), "utf8")).toBe("only in v1");
    expect(s.versions("foo").map((v) => v.version)).toEqual([2, 1]);
    expect(s.publishedIds()).toEqual(["foo"]);
  });

  it("is current only with a page: a newer version folder without one is passed over", () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo");
    mkdirSync(path.join(root, "foo", "v2"));
    writeFileSync(path.join(root, "foo", "v2", "scene.js"), "x");
    expect(s.readHtml("foo")).toContain("Foo");
    expect(s.readFile("foo", "scene.js")).toBeNull();
    // The folder still holds its number: the next version takes the one above.
    expect(s.nextVersion("foo")).toBe(3);
  });

  it("never writes over a version", () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo");
    const before = tree(path.join(root, "foo"));
    expect(() => s.addVersion("foo", 1, [{ path: "index.html", bytes: page("foo", "Other", 1) }])).toThrow(/already exists/);
    expect(tree(path.join(root, "foo"))).toEqual(before);
  });

  it("lists each version with its revision, newest first", () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo v1");
    install(s, "foo", "Foo v2");
    const revision = (n: number) => packageContentHash(readMotifDirectory(path.join(root, "foo", versionDirName(n))));
    expect(s.versions("foo")).toEqual([
      { version: 2, revision: revision(2), saved_at: expect.any(String) },
      { version: 1, revision: revision(1), saved_at: expect.any(String) },
    ]);
    expect(s.versionFiles("foo", 1)!.find((f) => f.path === "index.html")!.bytes.toString()).toContain("Foo v1");
    expect(s.versionFiles("foo", 3)).toBeNull();
    expect(s.versions("nothing")).toEqual([]);
  });
});

describe("UserMotifStore delete", () => {
  function trashing(fail = false) {
    const bin = mkdtempSync(path.join(tmpdir(), "motif-trash-"));
    const trashed: string[] = [];
    const trash: Trash = async (target) => {
      if (fail) throw new Error("the trash is unavailable");
      trashed.push(target);
      renameSync(target, path.join(bin, String(trashed.length)));
    };
    return { trash, trashed, bin };
  }

  it("moves the library folder, with every version, and the draft to the trash", async () => {
    const { trash, trashed, bin } = trashing();
    const s = new UserMotifStore(root, { trash });
    install(s, "foo", "Foo v1");
    install(s, "foo", "Foo v2");
    s.writeDraft("foo", composeMotifHtml(man("foo", "Draft", 1), body));
    await s.trashMotif("foo");
    expect(trashed).toEqual([path.join(root, "foo"), path.join(root, "drafts", "foo")]);
    expect(s.getMotif("foo")).toBeNull();
    expect(readdirSync(path.join(bin, "1")).sort()).toEqual(["v1", "v2"]);
    rmSync(bin, { recursive: true, force: true });
  });

  it("leaves the Motif installed and throws when the trash refuses", async () => {
    const { trash } = trashing(true);
    const s = new UserMotifStore(root, { trash });
    install(s, "foo", "Foo");
    const lineage = s.lineageOf("foo");
    await expect(s.trashMotif("foo")).rejects.toThrow(/trash/);
    expect(s.publishedIds()).toEqual(["foo"]);
    expect(s.readHtml("foo")).toContain("Foo");
    expect(s.lineageOf("foo")).toBe(lineage);
  });

  it("refuses without a trash", async () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo");
    await expect(s.trashMotif("foo")).rejects.toThrow(/trash/);
    expect(s.publishedIds()).toEqual(["foo"]);
  });
});

describe("UserMotifStore path safety", () => {
  it("rejects traversal in readFile", () => {
    const s = new UserMotifStore(root);
    expect(s.readFile("user-x", "../secret.txt")).toBeNull();
    expect(s.readFile("user-x", "a/../../b")).toBeNull();
    expect(s.readFile("..", "index.html")).toBeNull();
    expect(s.readFile("user-x", "/etc/hosts")).toBeNull();
    expect(s.readFile("user-x", "a\\b")).toBeNull();
    expect(s.readFile("user-x", ".")).toBeNull();
    expect(s.readFile("user-x", "")).toBeNull();
    expect(s.readFile("user-x", "C:/foo")).toBeNull();
    expect(s.readFile("drafts", "index.html")).toBeNull();
  });
  it("rejects unsafe ids on the write surface", async () => {
    const s = new UserMotifStore(root, { trash: async () => {} });
    expect(() => s.writeDraft("..", "html")).toThrow();
    expect(() => s.writeDraft("a/b", "html")).toThrow();
    expect(() => s.writeDraft("", "html")).toThrow();
    await expect(s.trashMotif("..")).rejects.toThrow();
    expect(() => s.addVersion("../escape", 1, [])).toThrow();
    expect(() => s.addVersion("ok", 1, [{ path: "../escape", bytes: Buffer.from("") }])).toThrow();
    expect(existsSync(path.join(root, "ok", "v1"))).toBe(false);
  });
});

describe("UserMotifStore reads", () => {
  it("reads an existing asset + html", () => {
    const dir = path.join(root, "user-x", "v1");
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    const manifestJson = `{"id":"user-x","name":"X","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}`;
    writeFileSync(path.join(dir, "index.html"), `<script type="application/json" id="motif-manifest">${manifestJson}</script><script>motif.define({setup(){}})</script>`);
    writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg/>");
    const s = new UserMotifStore(root);
    expect(s.readFile("user-x", "assets/logo.svg")?.toString()).toBe("<svg/>");
    expect(s.readHtml("user-x")).toContain("motif.define");
    expect(s.getMotif("user-x")?.manifest.id).toBe("user-x");
  });
  it("lists installed, skipping drafts and broken", () => {
    const dir = path.join(root, "user-a", "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), `<script type="application/json" id="motif-manifest">{"id":"user-a","name":"A","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script>`);
    mkdirSync(path.join(root, "drafts", "wip"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "wip", "index.html"), "draft");
    mkdirSync(path.join(root, "broken", "v1"), { recursive: true });
    writeFileSync(path.join(root, "broken", "v1", "index.html"), "<html>no island</html>");
    const s = new UserMotifStore(root);
    expect(s.listManifests().map((m) => m.id)).toEqual(["user-a"]);
  });
  it("missing root is empty", () => {
    const s = new UserMotifStore(path.join(root, "no", "such", "dir"));
    expect(s.listManifests()).toEqual([]);
    expect(s.readHtml("anything")).toBeNull();
  });
  it("hasFile resolves installed-then-draft and refuses unsafe paths", () => {
    const s = new UserMotifStore(root);
    // Draft-only: the companion sits beside the draft's index.html.
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo", 1), body));
    expect(s.hasFile("foo", "params.html")).toBe(false);
    writeFileSync(path.join(root, "drafts", "foo", "params.html"), "<html>p</html>");
    expect(s.hasFile("foo", "params.html")).toBe(true);
    install(s, "foo", "Foo", [{ path: "params.html", bytes: Buffer.from("<html>p</html>") }]);
    expect(s.hasFile("foo", "params.html")).toBe(true);
    // An installed Motif WITHOUT the file must not inherit a same-id draft's.
    s.writeDraft("bar", composeMotifHtml(man("bar", "Bar", 1), body));
    writeFileSync(path.join(root, "drafts", "bar", "params.html"), "<html>p</html>");
    install(s, "bar", "Bar");
    expect(s.hasFile("bar", "params.html")).toBe(false);
    // Same traversal guards as readFile.
    expect(s.hasFile("foo", "../params.html")).toBe(false);
    expect(s.hasFile("..", "params.html")).toBe(false);
    expect(s.hasFile("drafts", "params.html")).toBe(false);
    expect(s.hasFile("foo", "")).toBe(false);
  });
  it("readFile falls back to the draft and prefers the installed Motif", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Draft Foo", 1), "<head></head><body>draft<script>motif.define({setup(){}})</script></body>"));
    expect(s.readFile("foo", "index.html")?.toString()).toContain("draft");
    install(s, "foo", "Installed Foo");
    expect(s.readFile("foo", "index.html")?.toString()).toContain("Installed Foo");
  });
  it('never fills an installed package with resources from a same-id draft', () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo");
    s.writeDraftPackage('foo', composeMotifHtml(man('foo', 'Draft', 1), body), [
      { path: 'secret.bin', bytes: Buffer.from('draft-only') },
    ]);
    expect(s.readFile('foo', 'secret.bin')).toBeNull();
    expect(s.packageFiles('foo').map(f => f.path)).toEqual(['index.html']);
  });
});

describe("UserMotifStore legacy Update targets", () => {
  const html = composeMotifHtml(man("d1", "D1", 1), body);
  const stateOf = (id: string) => JSON.parse(readFileSync(path.join(root, ".workspaces", `${id}.json`), "utf8"));

  it("turns a draft's target file into its source and takes the file out of every package", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", html);
    writeFileSync(path.join(root, "drafts", "d1", "target"), "lower-third\n");
    // Format 0 kept an installed Motif at `<id>/`.
    mkdirSync(path.join(root, "foo"));
    writeFileSync(path.join(root, "foo", "index.html"), page("foo", "Foo", 1));
    writeFileSync(path.join(root, "foo", "target"), "foo");
    s.upgrade();
    expect(existsSync(path.join(root, "drafts", "d1", "target"))).toBe(false);
    expect(readdirSync(path.join(root, "foo", "v1"))).toEqual(["index.html"]);
    expect(stateOf("d1")).toEqual({ source_id: "lower-third" });
    // The revision is what it was while the store hid the file.
    expect(s.describe("d1")!.revision).toBe(motifContentHash(parseManifestIsland(html), html));
  });

  it("keeps a draft's own source or publication, and never records an unsafe id", () => {
    const s = new UserMotifStore(root);
    for (const id of ["kept", "published", "unsafe"]) {
      s.writeDraft(id, html);
      writeFileSync(path.join(root, "drafts", id, "target"), id === "unsafe" ? "../escape" : "lower-third");
    }
    mkdirSync(path.join(root, ".workspaces"), { recursive: true });
    writeFileSync(path.join(root, ".workspaces", "kept.json"), JSON.stringify({ source_id: "countdown" }));
    writeFileSync(path.join(root, ".workspaces", "published.json"), JSON.stringify({ publication: { id: "p", revision: "r", version: 1 } }));
    s.upgrade();
    expect(stateOf("kept")).toEqual({ source_id: "countdown" });
    expect(stateOf("published")).toEqual({ publication: { id: "p", revision: "r", version: 1 } });
    expect(existsSync(path.join(root, ".workspaces", "unsafe.json"))).toBe(false);
    for (const id of ["kept", "published", "unsafe"]) expect(existsSync(path.join(root, "drafts", id, "target"))).toBe(false);
  });

  it("upgrades once: a package's own target file outlives later launches", () => {
    new UserMotifStore(root).upgrade();
    const s = new UserMotifStore(root);
    s.writeDraft("d1", html);
    writeFileSync(path.join(root, "drafts", "d1", "target"), "an author's file");
    s.upgrade();
    new UserMotifStore(root).upgrade();
    expect(readFileSync(path.join(root, "drafts", "d1", "target"), "utf8")).toBe("an author's file");
    expect(existsSync(path.join(root, ".workspaces", "d1.json"))).toBe(false);
  });
});

// ADR 0172: format 1 kept an installed Motif's one version at `<id>/`.
describe("UserMotifStore versioning a format 1 library", () => {
  /** A format 1 package at `<id>/`, its manifest at `version`. */
  function legacy(id: string, version: number, files: Record<string, string> = {}) {
    mkdirSync(path.join(root, id), { recursive: true });
    writeFileSync(path.join(root, id, "index.html"), page(id, id, version));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, id, rel)), { recursive: true });
      writeFileSync(path.join(root, id, rel), text);
    }
  }
  const atFormat1 = () => writeFileSync(path.join(root, ".format"), "1");
  const revisionAt = (dir: string) => packageContentHash(readMotifDirectory(path.join(root, dir)));

  it("moves each package to the version its manifest names, keeping its revision", () => {
    atFormat1();
    legacy("card", 3, { "assets/logo.svg": "<svg/>" });
    // An author's own `v1/` folder is one of the package's files.
    legacy("strap", 1, { "v1/readme.txt": "mine" });
    mkdirSync(path.join(root, "broken"));
    writeFileSync(path.join(root, "broken", "index.html"), "<html>no island</html>");
    const before = { card: revisionAt("card"), strap: revisionAt("strap") };
    const s = new UserMotifStore(root);
    s.upgrade();
    expect(readdirSync(path.join(root, "card"))).toEqual(["v3"]);
    expect(readFileSync(path.join(root, "strap", "v1", "v1", "readme.txt"), "utf8")).toBe("mine");
    expect(readdirSync(path.join(root, "broken", "v1"))).toEqual(["index.html"]);
    // Stored frames and covers are keyed by id and revision: both hold.
    expect(s.describe("card")!.revision).toBe(before.card);
    expect(s.describe("strap")!.revision).toBe(before.strap);
    expect(s.listManifests().map((m) => [m.id, m.version])).toEqual([["card", 3], ["strap", 1]]);
    expect(readFileSync(path.join(root, ".format"), "utf8")).toBe("2");
  });

  it("runs once: a later launch leaves the library as it finds it", () => {
    atFormat1();
    legacy("card", 1);
    new UserMotifStore(root).upgrade();
    // A package written by hand in the old layout after the upgrade is not moved.
    legacy("later", 1);
    const before = tree(root);
    new UserMotifStore(root).upgrade();
    expect(tree(root)).toEqual(before);
  });

  it("finishes a move a crash interrupted", () => {
    atFormat1();
    legacy("card", 2, { "scene.js": "x" });
    legacy("strap", 1);
    const before = { card: revisionAt("card"), strap: revisionAt("strap") };
    // One crashed after leaving its folder, one after its new folder was made.
    renameSync(path.join(root, "card"), path.join(root, ".versioning-card"));
    renameSync(path.join(root, "strap"), path.join(root, ".versioning-strap"));
    mkdirSync(path.join(root, "strap"));
    const s = new UserMotifStore(root);
    s.upgrade();
    expect(readdirSync(root).filter((name) => name.startsWith(".versioning-"))).toEqual([]);
    expect(s.describe("card")!.revision).toBe(before.card);
    expect(s.describe("strap")!.revision).toBe(before.strap);
    expect(readdirSync(path.join(root, "card"))).toEqual(["v2"]);
  });
});

describe("UserMotifStore revision snapshots", () => {
  it("keeps a snapshot a host holds through later pins, and two that none hold", () => {
    const s = new UserMotifStore(root);
    const ids = ["a", "b", "c", "d"];
    const revision: Record<string, string> = {};
    for (const id of ids) {
      s.writeDraft(id, composeMotifHtml(man(id, id, 1), body));
      const m = s.getMotif(id)!;
      revision[id] = motifContentHash(m.manifest, m.html, s.packageFiles(id));
    }
    const served = (id: string) => s.readFile(id, `.revisions/${revision[id]}/index.html`) !== null;
    // The first host is still loading its page when three more pin theirs.
    const first = s.pinPackage("a", revision.a!)!;
    const later = ["b", "c", "d"].map((id) => s.pinPackage(id, revision[id]!)!);
    expect(served("a")).toBe(true);
    first.release();
    first.release();
    for (const pin of later) pin.release();
    // None held: the two pinned last stay for reuse.
    expect(ids.map(served)).toEqual([false, false, true, true]);
    expect(s.pinPackage("gone", revision.a!)).toBeNull();
  });
});
