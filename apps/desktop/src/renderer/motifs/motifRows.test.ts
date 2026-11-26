// How a project copy and the library's version are told apart for the
// property panel's Version row: by the version the copy came from and the
// library's current one.
import { describe, expect, it } from "vitest";
import type { LibraryMotifRow, MotifSummary, ProjectMotifRow } from "../ipc";
import { libraryRowOf, versionGap } from "./motifRows";

const summary = (version: number): MotifSummary =>
  ({ id: "card", name: "Card", version, size: [64, 64], default_duration_s: 1, props_schema: {} } as unknown as MotifSummary);

const lib = (version: number, over: Partial<LibraryMotifRow> = {}): LibraryMotifRow =>
  ({ group: "library", id: "card", status: "installed", revision: `lib-${version}`, in_project: "card", motif: summary(version), ...over });

const proj = (over: Partial<ProjectMotifRow>): ProjectMotifRow =>
  ({ group: "project", id: "card", uid: "lineage", status: "ok", state: "modified", from: null, path: "/home/u/Film/Motifs/card",
    revision: "proj", motif: summary(1), ...over });

const from = (version: number) => ({ uid: "lineage", version, revision: `lib-${version}` });

describe("versionGap", () => {
  it("names nothing when the two match or the library has no version of it", () => {
    expect(versionGap(proj({ state: "in_sync", from: from(2) }), lib(2))).toBeNull();
    expect(versionGap(proj({ state: "project_only" }), undefined)).toBeNull();
  });

  it("an unchanged older copy is behind the library's version", () => {
    expect(versionGap(proj({ state: "update_available", from: from(2) }), lib(3))).toEqual({ kind: "behind", ours: 2, theirs: 3 });
  });

  it("a copy edited here while the library stayed where it came from is edited", () => {
    expect(versionGap(proj({ state: "modified", from: from(2) }), lib(2))).toEqual({ kind: "edited", base: 2 });
  });

  it("a copy edited here while the library moved on has diverged: taking the library's drops the edits", () => {
    expect(versionGap(proj({ state: "modified", from: from(2) }), lib(4))).toEqual({ kind: "diverged", base: 2, theirs: 4 });
  });

  it("a copy with no library version it came from only differs", () => {
    expect(versionGap(proj({ state: "modified", from: null }), lib(3))).toEqual({ kind: "differs", theirs: 3 });
    expect(versionGap(proj({ state: "modified", from: { uid: "other", version: 1, revision: "x" } }), lib(3)))
      .toEqual({ kind: "differs", theirs: 3 });
  });

  it("says nothing for a folder that cannot render: the panel says why instead", () => {
    expect(versionGap(proj({ status: "missing", state: "modified", from: from(1) }), lib(2))).toBeNull();
    expect(versionGap(proj({ status: "invalid", state: "modified", from: from(1) }), lib(2))).toBeNull();
  });
});

describe("libraryRowOf", () => {
  it("compares with the library row holding the project's copy, a built-in before an installed one", () => {
    const installed = lib(5, { id: "card-mine" });
    const builtin = lib(1, { status: "builtin" });
    expect(libraryRowOf(proj({}), [installed, builtin])).toBe(builtin);
    expect(libraryRowOf(proj({}), [installed])).toBe(installed);
    expect(libraryRowOf(proj({}), [lib(2, { in_project: null })])).toBeUndefined();
  });
});
