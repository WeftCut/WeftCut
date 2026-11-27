// The Motifs panel's rows: the open project's Motifs and the library's, what
// each shows and offers. Pure, so the rules read and test apart from React.
import { libraryHost, type MotifStatus } from "../../shared/motifs/projectMotifs";
import type { LibraryMotifRow, MotifSummary, ProjectMotifRow } from "../ipc";

export type MotifRow = ProjectMotifRow | LibraryMotifRow;

/** A row's key across both groups: one id may be in each. */
export function rowKey(row: Pick<MotifRow, "group" | "id">): string {
  return `${row.group}:${row.id}`;
}

/** The `motif://` host a row's previews and cover are captured under. */
export function rowHost(row: MotifRow): string {
  return row.group === "library" ? libraryHost(row.id) : row.id;
}

/** Whether the row's Motif may run here for a preview, a cover or a
 *  placement, and is offered for export: every library row, a project row
 *  only when `ok` (an untrusted one's code has not run on this machine, ADR
 *  0174, though its row carries its manifest). */
export function rowRenders(row: MotifRow): boolean {
  return row.group === "library" || row.status === "ok";
}

/** The row's Motif as its previews capture it: under its host. */
export function previewMotif(row: MotifRow): MotifSummary | null {
  return rowRenders(row) && row.motif ? { ...row.motif, id: rowHost(row) } : null;
}

export function rowName(row: MotifRow): string {
  return row.motif?.name ?? row.id;
}

/** What a project row says about itself, most pressing first: a Motif that
 *  cannot render says only why (missing, invalid, then untrusted). */
export type ProjectRowBadge = "missing" | "invalid" | "untrusted" | "update_available" | "modified" | "project_only";

export function projectRowBadge(row: ProjectMotifRow): ProjectRowBadge | null {
  if (row.status !== "ok") return row.status;
  return row.state === "in_sync" ? null : row.state;
}

/** Whether the library holds a version of the row's lineage to take: an
 *  update of a copy the library moved past or one edited here (an untrusted
 *  copy too: its state says how it stands against the library), or the
 *  restore of a folder gone or broken. */
export type LibraryTake = "update" | "restore" | null;

export function libraryTake(row: ProjectMotifRow): LibraryTake {
  if (row.state === "project_only") return null;
  if (row.status === "missing" || row.status === "invalid") return "restore";
  return row.state === "in_sync" ? null : "update";
}

/** The state of the project's copy of a library row's lineage: whether it
 *  renders, or null when the project holds none. `project` is the whole
 *  group, not a filtered view of it. */
export type ProjectCopy = MotifStatus | null;

export function projectCopyOf(row: LibraryMotifRow, project: readonly ProjectMotifRow[]): ProjectCopy {
  if (row.in_project === null) return null;
  return project.find((p) => p.id === row.in_project)?.status ?? "ok";
}

/** Whether "Save to library" has something to save: a project Motif that
 *  renders and differs from the library's (or that the library lacks). */
export function canSaveToLibrary(row: ProjectMotifRow): boolean {
  return row.status === "ok" && (row.state === "modified" || row.state === "project_only");
}

/** Rows whose name or id holds `query`, case-insensitively. Ids are matched
 *  too: agents quote them, and pasting one should find its row. */
export function matchRows<R extends MotifRow>(rows: readonly R[], query: string): R[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((row) => rowName(row).toLowerCase().includes(q) || row.id.toLowerCase().includes(q));
}

/** The library row a project Motif is compared with: the library's current
 *  Motif of its lineage. A built-in is that Motif even when an installed one
 *  shares its lineage, as main decides (`libraryHeadOfLineage`). */
export function libraryRowOf(row: ProjectMotifRow, library: readonly LibraryMotifRow[]): LibraryMotifRow | undefined {
  const held = library.filter((r) => r.in_project === row.id);
  return held.find((r) => r.status === "builtin") ?? held[0];
}

/** How a project copy and the library's version stand apart, by version
 *  number, when they differ: the copy is an unchanged older version
 *  (`behind`), was edited here while the library stayed at the version it
 *  came from (`edited`), was edited here while the library moved on
 *  (`diverged`: taking the library's version drops the edits), or differs
 *  with no version it came from to name (`differs`). Null when they match,
 *  when the library has no version of it, or when its folder cannot render
 *  (the panel says why instead). */
export type VersionGap =
  | { kind: "behind"; ours: number; theirs: number }
  | { kind: "edited"; base: number }
  | { kind: "diverged"; base: number; theirs: number }
  | { kind: "differs"; theirs: number };

export function versionGap(row: ProjectMotifRow, library: LibraryMotifRow | undefined): VersionGap | null {
  if (row.status === "missing" || row.status === "invalid") return null;
  if (row.state !== "update_available" && row.state !== "modified") return null;
  const theirs = library?.motif.version;
  if (theirs === undefined) return null;
  const base = row.from && row.from.uid === row.uid ? row.from.version : null;
  if (base === null) return { kind: "differs", theirs };
  if (row.state === "update_available") return { kind: "behind", ours: base, theirs };
  return base < theirs ? { kind: "diverged", base, theirs } : { kind: "edited", base };
}
