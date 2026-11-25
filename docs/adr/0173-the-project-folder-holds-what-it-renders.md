---
status: accepted
---

# The project folder holds what it renders

Date: 2026-11-17

## Context

Media travels with a project: imports are copied into `Media/` and healed by
their bytes (ADR 0151). Motifs did not. A Motif layer stored a `motif_id` and a
`motif_version`, resolved app-wide: a built-in id first, then the installed
Motif, then a draft. Moved to another machine, a project lost every Motif its
library lacked; preview drew nothing and export skipped the layer with a
console warning (ADR 0156 forbids that). On the same machine, an update of an
installed Motif re-rendered every film that used it, signalled only by a notice
at the next open. Drafts and their linked working directories were app-wide
too, the link an absolute path.

## Decision

- **A project renders its own Motifs.** Each is a folder `Motifs/<id>/` named
  in the `motifs` table of `project.wcpr`: `{ <id>: { uid, revision, from } }`,
  where `uid` is the lineage (ADR 0171), `revision` the folder revision the
  project last recorded (null when no folder was ever made), and `from` the
  library `{uid, version, revision}` it was copied from (null for a Motif made
  in the project). The id is the folder name and the `motif://` host, so it is
  one lowercase host label with no `--`. Every Motif layer names a table entry;
  layers no longer carry `motif_version`. The table is recorded state: each
  change is a commit in the undo history.
- **Placing copies, built-ins too.** Placing a library Motif copies its package
  into `Motifs/` and records the entry with the layer in one commit. A lineage
  the project holds is placed under its existing id. An automatic copy whose id
  another lineage holds takes `<id>-<first 8 hex of uid>`. Undo leaves the
  folder on disk, untracked, as it leaves `Media/`.
- **Resolution is the project only.** `motif://<id>` serves the open project's
  folder; `<id>--library` the library's current version, a built-in's bundled
  bytes included; `<proposal id>--proposal` a frozen proposal. One resolver
  decides `ok | missing | invalid` for the protocol, capture, pins and covers.
  A built-in id no longer wins over the project.
- **A folder's revision is its files as they stand.** The app never rewrites a
  folder an author edits. A copy under its library id keeps the library
  revision, so stored frames keep their keys.
- **Agents edit in place, without approval.** `update_motif_files` writes the
  folder, or the agent writes the files itself. The project's `Motifs/` is
  watched; a new revision of an entry that makes a package becomes a recorded
  commit attributed to file edits (an agent, so Review lists it where it
  plays). An invalid folder is status only, never recorded.
- **Recorded revisions are backed up** in `Backups/motifs/`, content-addressed.
  Undo, redo and a checkpoint restore put each folder back to the revision the
  restored state records when it holds the one recorded before; a folder
  holding any other edit is left alone, and recorded when it makes a package.
  Updating the project copy from the library is one undo step; files there
  that make no package are first moved to `Backups/motifs/unfinished/`.
- **Missing is visible.** A Motif that cannot render is listed in
  `project://session`, draws an error placeholder in the picture, and export
  refuses `MotifUnavailable` naming it while a layer uses it.
- **The library is where Motifs come from and are saved to.** It keeps every
  version (ADR 0172). The user's Save to library adds a version; an agent's
  `install_motif` only proposes (ADR 0046 note). Neither changes any project:
  projects of that lineage show *update available*. The one exception is a
  save as a new library Motif while its source project is open: the entry
  follows the new lineage in a commit of the user's.
- **Drafts and linked directories are gone.** Their folders, `drafts/` and
  `.workspaces/` in the library, stay on disk untouched and unlisted; one
  startup notice counts the drafts left. Only the v5 → v6 upgrade reads them.
- **v5 → v6** copies into `Motifs/` the package v5 rendered for each referenced
  id. An id nothing resolves stays in the table as missing; an open is never
  refused for a Motif.
- **MCP contract.** `create_motif { source: empty | copy | zip | directory }`
  replaces `open_motif_draft`. Tools name a project Motif, or a library one with
  `group: "library"`; `list_motifs` reports both groups with derived row states.
  `install_motif` proposes a project Motif to the library. `delete_motif`
  removes a Motif from the project, refused while a layer uses it; only the
  user deletes from the library.

## Consequences

- A project folder copied to a machine with an empty library plays and exports
  the same Motifs. An app update never changes a finished film; a built-in's
  new bytes show as *update available*.
- A received project carries Motif code that would run on open. Motif trust
  (ticket 05) must ship in the same release as this.
- Project folders grow by the Motifs they use. Two projects of one lineage
  diverge independently; nothing tracks which projects use a library Motif.
- An edit the user makes in their own editor is recorded like an agent's.
- Clients that call `open_motif_draft` fail on the first call; the skill and
  the app change together (ADR 0046).

Rejected: projects referencing a shared, revision-keyed library (the folder
still would not carry what it renders); pinning a library version per layer
(a dependency all the same); keeping app-wide drafts beside project copies
(two places to edit one Motif); approval for project edits (an agent editing
its own project's files is gated by undo and Review, as any edit); moving old
drafts into the library on upgrade (it would publish unreviewed content).
