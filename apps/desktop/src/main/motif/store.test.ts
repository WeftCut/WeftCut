import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UserMotifStore, versionDirName, type Trash } from "./store";
import { composeMotifHtml, type Manifest } from "../../shared/motifs/catalog";
import { packageContentHash } from "./contentHash";
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

describe("UserMotifStore versions", () => {
  it("serves the current version, and never an older version's files", () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo v1", [{ path: "old.txt", bytes: Buffer.from("only in v1") }]);
    install(s, "foo", "Foo v2");
    const current = s.listManifests().find((m) => m.id === "foo")!;
    expect(current.version).toBe(2);
    expect(current.name).toBe("Foo v2");
    expect(s.installedFile("foo", "index.html")!.toString()).toContain("Foo v2");
    expect(s.installedFile("foo", "old.txt")).toBeNull();
    expect(s.installedSnapshot("foo")!.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(s.installedHead("foo")).toEqual({ version: 2, revision: s.installedListing("foo")!.revision });
    expect(s.installedListing("foo")!.revision).toBe(packageContentHash(readMotifDirectory(path.join(root, "foo", "v2"))));
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
    expect(s.installedFile("foo", "index.html")!.toString()).toContain("Foo");
    expect(s.installedFile("foo", "scene.js")).toBeNull();
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

  it("moves the library folder, with every version, to the trash; an older release's draft stays", async () => {
    const { trash, trashed, bin } = trashing();
    const s = new UserMotifStore(root, { trash });
    install(s, "foo", "Foo v1");
    install(s, "foo", "Foo v2");
    mkdirSync(path.join(root, "drafts", "foo"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "foo", "index.html"), page("foo", "Draft", 1));
    await s.trashMotif("foo");
    expect(trashed).toEqual([path.join(root, "foo")]);
    expect(s.installedManifest("foo")).toBeNull();
    expect(existsSync(path.join(root, "drafts", "foo", "index.html"))).toBe(true);
    expect(readdirSync(path.join(bin, "1")).sort()).toEqual(["v1", "v2"]);
    rmSync(bin, { recursive: true, force: true });
  });

  it("leaves the Motif installed and throws when the trash refuses", async () => {
    const { trash } = trashing(true);
    const s = new UserMotifStore(root, { trash });
    install(s, "foo", "Foo");
    const lineage = s.lineage.of("foo");
    await expect(s.trashMotif("foo")).rejects.toThrow(/trash/);
    expect(s.publishedIds()).toEqual(["foo"]);
    expect(s.installedFile("foo", "index.html")!.toString()).toContain("Foo");
    expect(s.lineage.peek("foo")).toBe(lineage);
  });

  it("refuses without a trash", async () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo");
    await expect(s.trashMotif("foo")).rejects.toThrow(/trash/);
    expect(s.publishedIds()).toEqual(["foo"]);
  });
});

describe("UserMotifStore path safety", () => {
  it("rejects traversal in reads", () => {
    const s = new UserMotifStore(root);
    install(s, "user-x", "X");
    for (const rel of ["../secret.txt", "a/../../b", "/etc/hosts", "a\\b", ".", "", "C:/foo"]) {
      expect(s.installedFile("user-x", rel), rel).toBeNull();
      expect(s.proposalFile("p", rel), rel).toBeNull();
    }
    expect(s.installedFile("..", "index.html")).toBeNull();
    expect(s.installedFile(".proposals", "index.html")).toBeNull();
    expect(s.proposalFile("..", "index.html")).toBeNull();
    mkdirSync(path.join(root, "drafts", "v1"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "v1", "index.html"), page("drafts", "Draft", 1));
    expect(s.installedFile("drafts", "index.html")).toBeNull();
  });
  it("rejects unsafe ids on the write surface", async () => {
    const s = new UserMotifStore(root, { trash: async () => {} });
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
    expect(s.installedFile("user-x", "assets/logo.svg")?.toString()).toBe("<svg/>");
    expect(s.installedFile("user-x", "index.html")!.toString()).toContain("motif.define");
    expect(s.installedManifest("user-x")?.id).toBe("user-x");
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
    expect(s.installedFile("anything", "index.html")).toBeNull();
  });
  it("never fills an installed package with resources from an older release's same-id draft", () => {
    const s = new UserMotifStore(root);
    install(s, "foo", "Foo");
    mkdirSync(path.join(root, "drafts", "foo"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "foo", "index.html"), page("foo", "Draft", 1));
    writeFileSync(path.join(root, "drafts", "foo", "secret.bin"), "draft-only");
    expect(s.installedFile("foo", "secret.bin")).toBeNull();
    expect(s.installedSnapshot("foo")!.files.map(f => f.path)).toEqual(["index.html"]);
  });
});

describe("UserMotifStore legacy Update targets", () => {
  it("takes a format 0 target file out of every package, an older release's drafts included", () => {
    const s = new UserMotifStore(root);
    mkdirSync(path.join(root, "drafts", "d1"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "d1", "index.html"), page("d1", "D1", 1));
    writeFileSync(path.join(root, "drafts", "d1", "target"), "lower-third\n");
    // Format 0 kept an installed Motif at `<id>/`.
    mkdirSync(path.join(root, "foo"));
    writeFileSync(path.join(root, "foo", "index.html"), page("foo", "Foo", 1));
    writeFileSync(path.join(root, "foo", "target"), "foo");
    s.upgrade();
    expect(readdirSync(path.join(root, "drafts", "d1"))).toEqual(["index.html"]);
    expect(readdirSync(path.join(root, "foo", "v1"))).toEqual(["index.html"]);
    expect(existsSync(path.join(root, ".workspaces"))).toBe(false);
  });

  it("upgrades once: a package's own target file outlives later launches", () => {
    new UserMotifStore(root).upgrade();
    mkdirSync(path.join(root, "drafts", "d1"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "d1", "index.html"), page("d1", "D1", 1));
    writeFileSync(path.join(root, "drafts", "d1", "target"), "an author's file");
    new UserMotifStore(root).upgrade();
    expect(readFileSync(path.join(root, "drafts", "d1", "target"), "utf8")).toBe("an author's file");
  });
});

describe("UserMotifStore staging a crash left", () => {
  const uuid = "0f8e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4";

  it("removes it at every launch, and nothing the store lists", () => {
    const s = new UserMotifStore(root);
    s.upgrade();
    install(s, "foo", "Foo");
    // A publication and a proposal, each interrupted before its rename.
    mkdirSync(path.join(root, "foo", `.stage-${uuid}`));
    writeFileSync(path.join(root, "foo", `.stage-${uuid}`, "index.html"), page("foo", "Half", 2));
    mkdirSync(path.join(root, ".proposals", `${uuid}.stage-${uuid}`), { recursive: true });
    writeFileSync(path.join(root, ".proposals", `${uuid}.stage-${uuid}`, "index.html"), page("bar", "Half", 1));
    mkdirSync(path.join(root, ".proposals", uuid));
    writeFileSync(path.join(root, ".proposals", uuid, "index.html"), page("bar", "Bar", 1));
    const listed = { manifests: s.listManifests(), versions: s.versions("foo"), proposal: s.proposalListing(uuid) };
    new UserMotifStore(root).upgrade();
    expect(readdirSync(path.join(root, "foo"))).toEqual(["v1"]);
    expect(readdirSync(path.join(root, ".proposals"))).toEqual([uuid]);
    const after = new UserMotifStore(root);
    expect({ manifests: after.listManifests(), versions: after.versions("foo"), proposal: after.proposalListing(uuid) }).toEqual(listed);
  });

  it("leaves an older release's package whole: its files are the author's", () => {
    writeFileSync(path.join(root, ".format"), "1");
    mkdirSync(path.join(root, "card", ".stage-mine"), { recursive: true });
    writeFileSync(path.join(root, "card", "index.html"), page("card", "Card", 1));
    writeFileSync(path.join(root, "card", ".stage-mine", "notes.txt"), "mine");
    new UserMotifStore(root).upgrade();
    expect(readFileSync(path.join(root, "card", "v1", ".stage-mine", "notes.txt"), "utf8")).toBe("mine");
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
    expect(s.installedListing("card")!.revision).toBe(before.card);
    expect(s.installedListing("strap")!.revision).toBe(before.strap);
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
    expect(s.installedListing("card")!.revision).toBe(before.card);
    expect(s.installedListing("strap")!.revision).toBe(before.strap);
    expect(readdirSync(path.join(root, "card"))).toEqual(["v2"]);
  });
});

