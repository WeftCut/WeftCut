# Motif workspaces

The Motif tools are list_motifs, create_motif, read_motif,
update_motif_files, preview_motif, install_motif, export_motif and
delete_motif. They take paths and inline text; no tool is specific to a file
format or model type. Every one names its subject Motif motif_id.

## Where a project's Motifs live

A project renders its own Motifs. Each is a folder `Motifs/<id>/` in the
project folder, named in the project's Motif table in project.wcpr. The table
records each Motif's lineage, the revision the project last recorded for its
folder, and the library version it was copied from, if any. The id is the
folder name.

The library holds the built-in Motifs and the ones the user saved. It is where
Motifs are placed from and saved to; a project never renders from it. Tools
name a project Motif by default and a library Motif with group "library".

Placing a library Motif with add_layers copies its package into `Motifs/` and
records it with the layer in one undo step; built-ins are copied too. A Motif
of the same lineage already in the project is placed under its existing id,
with no new copy. When another Motif holds the id, the copy takes the id plus a
dash and 8 hex digits of its lineage. To place the library's Motif under an id
the project uses for a different one, pass from_library: true.

list_motifs answers both groups, or the one group names. A project row has:

- status: ok, missing (no folder), invalid (its files make no package) or
  untrusted (a package this machine has not trusted, below), with a
  diagnostic;
- state against the library Motif of the same lineage: in_sync, modified
  (changed since it was copied), update_available (an unchanged copy the
  library has moved past) or project_only (the library holds no such
  lineage);
- from, path (its folder) and publication (the latest proposal, below).

A library row has status builtin or installed, its version, and in_project:
the id the open project holds it under, or null. `motifs://current` lists the
project rows.

## Trust

A Motif runs only when this machine trusts its revision (ADR 0174). One placed
from this library, made in the project here (a folder first written under
`Motifs/` while the project is open included), or edited from a trusted
revision while the project is open here is trusted without asking. One found when a project is opened (a
project received from someone else), or brought in from a ZIP or a folder
outside the project's `Motifs/`, is untrusted: it renders nothing, the
picture shows an error placeholder, and preview_motif, a copy and
install_motif refuse it. read_motif reads its files as text and export_motif
writes them out; neither runs it.

Only the user trusts a Motif, on its card in the app's Motifs panel. When a
received project lists untrusted Motifs, read them with read_motif if the user
asks what they do, say what you found, and leave the decision to the user.

## Making a Motif

create_motif makes a Motif in the open project from exactly one source:

```json
{"source":{"kind":"empty","name":"My Motif"}}
{"source":{"kind":"copy","motif_id":"lower-third","group":"library"}}
{"source":{"kind":"zip","path":"C:/work/package.zip"}}
{"source":{"kind":"directory","path":"C:/work/title-overlay"}}
```

It answers motif_id, revision and path, the folder that now holds the Motif.
The id is made from the Motif's name and numbered when the project holds it.

- empty: a 960×540 canvas, 5 s long, with no props. Its optional files, in
  update_motif_files form, are laid over it in the same undo step; a
  manifest.json among them names the Motif.
- copy: an independent copy of a project or library Motif, of a new lineage,
  so it reads as project only. Copy a Motif to change it for some clips while
  the others keep the original.
- zip: an exported package. It keeps the id and the lineage it carries; an id
  the project holds gets the lineage suffix instead of a number. It is
  untrusted until the user trusts it, unless this machine already trusts
  those exact bytes, as it does a ZIP exported from this library, under
  whichever id the copy takes.
- directory: copies a package folder once; later edits to the source folder
  do not reach the project, and the copy is untrusted like a ZIP. A folder you
  wrote under the project's `Motifs/` yourself is adopted in place instead,
  under its own name, which must be lowercase letters, digits and single
  dashes; written while the project is open, it was made here and is
  trusted, unless it is a copy or move of a Motif found untrusted.

A package folder contains index.html and a manifest.json (authoritative when
present), or an HTML manifest island, plus all runtime assets. Use a
package/output folder, not an entire repository with node_modules. Paths must
be portable; links/junctions are refused. The package is bounded to 256 MiB
and 10,000 files. All resource URLs should be relative.

## Editing in place

Edit the files under path with your normal file tools. Project Motif edits
need no approval. The app watches `Motifs/`: each save that leaves a valid
package becomes one commit in the user's undo history, made by file edits,
and Review shows the change where the Motif plays. Saves close together are
recorded as one. A save that leaves the package invalid is not recorded: the
Motif reports status invalid with its diagnostic, preview and export refuse
it, and the next valid save is recorded. The folder is read again only when a
file's size, times or identity changed (ADR 0164). A save recorded right after
an undo is a new commit, so it clears redo: the app never overwrites an edit
it has not recorded.

Every Motif layer re-renders from the new revision; the frame cache is keyed
by it. To change a Motif for some clips only, copy it first (above).

A folder the table does not name renders nothing. Write a new Motif's folder,
then adopt it with a directory source, or start from create_motif and edit
the folder it answers.

## Without a shared folder

When you cannot reach the project folder, work through the tools. read_motif
with an id returns manifest, status, revision, folder path and file inventory
(path, size, SHA-256); it does not dump code or binary content. With path, a
UTF-8 file returns its text (up to 256 KiB; a larger text file is refused, not
truncated) and a binary file returns only its size and SHA-256. A Motif whose
files make no package is still read, with its diagnostic, so it can be fixed.

Small binary assets go inline: an update_motif_files entry `{path, base64}`
carries the whole file as canonical base64, at most 256 KiB decoded per entry
and 4 MiB per call; invalid base64 is refused. Anything larger travels as a
package: a ZIP or a directory the app can read, through create_motif.

Batch edits through update_motif_files:

```json
{
  "motif_id":"title-card",
  "expected_revision":"<revision just read>",
  "files":[
    {"path":"scene.js","text":"/* replacement source */"},
    {"path":"index.html","edits":[{"old":"font-size: 56px","new":"font-size: 48px"}]},
    {"path":"assets/logo.png","base64":"iVBORw0KGgo..."},
    {"path":"assets/old.png","delete":true}
  ]
}
```

Each entry has exactly one operation: text (the whole file), base64, edits or
delete; any other key is refused. Edits change part of an existing UTF-8 file:
each `old` must occur exactly once in the text the previous edit left, or the
whole batch is refused with the edit's number; read the file again and resend.
Prefer edits to resending a file you have already written; creating a file
still takes text. The complete resulting package is validated before any
write. The files are then written one by one into the folder, after checking
that nothing changed it since the read; a failed write puts back the files
already written. The call is one commit in the user's undo history. A stale
expected_revision is refused with the current revision: read again and merge
instead of retrying. A folder whose files make no package has no revision;
repair it with expected_revision null, which a valid folder refuses. When the commit is refused with HistoryLocked (another
session holds the history), the files are already written and stay: the app
records them as a file edit, like any save in the folder. Do not write them
again.

## Review and undo

Undo, redo and restoring a checkpoint put each Motif folder back as the
restored state records it. Every revision the project records is kept in
`Backups/motifs/` for that. A folder holding an invalid package at that moment
is left as it is, since it is an edit in progress. Undoing a create_motif or a
placement removes the Motif from the table and leaves its folder on disk.

delete_motif removes a Motif from the project, as one undo step; its folder
stays on disk. It is refused while a layer uses the Motif. Only the user
deletes a library Motif, in the app.

A Motif that cannot render is listed in `project://session`, shows an error
placeholder in the picture, and makes start_export refuse while a layer uses
it. Restore its folder or fix its files.

## Updating from the library

When the library has moved past an unchanged copy, its row reads
update_available. The user updates the project copy from the Motifs panel; no
MCP tool does. The update replaces the folder with the library's current
version and fits the props of every clip on it to the new props schema, in one
undo step; the replaced revision stays in `Backups/motifs/`. Updating a
modified copy replaces its edits, and undo brings them back. Tell the user when
an update is available rather than copying library files over the folder.

## Saving to the library

Saving to the library waits for the user. install_motif takes a project
Motif's motif_id and, optionally, the reviewed expected_revision, and only
proposes: it freezes that revision and answers awaiting_approval with a
proposal id and its target, a library Motif's id and version or a new id. The
library is untouched and no project changes.

The target is the library Motif of the same lineage, as a new version. Name
another with target_id and expected_version. Otherwise it is a new library
Motif whose id comes from the manifest name; a name with no ASCII letter or
digit gives `motif-` and hex digits of the lineage (ADR 0171), so names in any
script work. If a library Motif, a built-in or another pending proposal holds
that id, the proposal is refused naming the holder and the ways forward:
rename the manifest name, or replace the library Motif with target_id and
expected_version. Nothing is renamed with a number. Built-ins cannot be
replaced, so a changed copy of a built-in is saved as a new Motif under a new
name.

The user sees a card in the app's Motifs panel with the proposed package in
the preview player, its props, and what changed against the library version
it replaces; a small note in the status bar points to it. Approve adds the
frozen revision as a new library version (earlier versions stay), or saves it
as a new library Motif. Reject stores the user's note. Neither changes any
project, except that a Motif saved as new while its project is open follows
the new library Motif. Projects of the same lineage then show
update_available.

Tell the user the proposal is waiting and stop; do not poll. list_motifs
shows the outcome on the project row as publication (state, note, library id
and version), and the catalog's list-changed notification fires on every
change. Proposing again from the same Motif supersedes the older proposal;
the same revision and target again is the same proposal. Edits made after
proposing are not in the proposal.

The user's own Save to library publishes directly, to the same default
target, with "save as new" beside it.

## Preview and export

preview_motif takes 1–24 times (local_t_s, seconds from the Motif's start,
not timeline time) and returns one labelled PNG contact sheet, plus the exact
revision and the canvas and frame sizes. Each frame is the whole canvas at its
own size scaled to fit width and height (640 wide when neither is given; at
most 2×, aspect kept, never cropped); frames keep their transparency. Supply
expected_revision to insist on a previously read version. It refuses a Motif
that cannot render.

export_motif writes a complete ZIP to path, which is required: an absolute
local `.zip` path in an existing folder; an existing file is refused, never
overwritten. The ZIP names the Motif's lineage beside its folder, so a
project that imports it keeps the lineage. preview_motif, read_motif and
export_motif read a library Motif with group "library".

Captures pin companion URLs under a revision path, so a source edit cannot
swap assets midway through a capture. Only a bounded number of revisions stay
pinned; a request for an evicted stale revision fails and needs a catalog
refresh, rather than rendering new bytes under an old hash.

## Drafts from earlier versions

Earlier versions kept app-wide drafts, some linked to a working folder. They
are no longer listed, and their folders stay in the library's drafts folder
untouched; one notice says how many are left. A project that used one gets
its own copy when it is upgraded, unless the draft's linked working folder
could not be read: it rendered nothing then, so the Motif stays missing. The
upgrade's log row names each missing Motif with the draft of its id, when one
is left. Copying that draft's folder to the project's `Motifs/<id>/` while
the project is open restores the Motif, trusted as made here; create_motif
would add a new Motif beside the missing one instead. To use any other draft,
run create_motif with a directory source on its folder, or on the working
folder it was linked to.
