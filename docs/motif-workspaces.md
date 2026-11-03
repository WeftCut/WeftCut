# Motif workspaces

The Motif tools are list_motifs, open_motif_draft, read_motif,
update_motif_files, preview_motif, install_motif, export_motif and
delete_motif. They take paths and inline text; no tool is specific to a file
format or model type. Every one names its subject Motif motif_id.

## Local directory workflow

```json
{"source":{"kind":"directory","path":"C:/work/title-overlay"}}
```

Pass this to open_motif_draft. The directory contains index.html and a
manifest.json (authoritative when present), or an HTML manifest island, plus
all runtime assets. Use a package/output folder, not an entire repository with
node_modules. Paths must be portable; links/junctions are refused. The package
is bounded to 256 MiB and 10,000 files. All resource URLs should be relative.

The result contains motif_id (the draft's id) and revision. Reopening the same directory
returns its existing draft. Save files normally: the app watches the folder and
validates/copies stable content into its own rendering snapshot. It does not
inject ids into or move the source directory. Invalid changes keep the last
valid snapshot with an explicit diagnostic; preview, publication and export
refuse that stale content rather than approving it. read_motif refreshes before
answering. A deleted or unavailable directory reports diagnostics and recovers
when restored.

Other mutually exclusive source variants:

```json
{"source":{"kind":"motif","motif_id":"countdown"}}
{"source":{"kind":"copy","motif_id":"my-motif-draft"}}
{"source":{"kind":"zip","path":"C:/work/package.zip"}}
{"source":{"kind":"empty","name":"My Motif"}}
```

`motif` with a draft's id resumes that draft; with any other id it copies the
Motif into a new draft without choosing a publication target. copy always
makes an independent copy, a draft included, in one call. A copy answers
source with the copied Motif's id and version: pass them as target_id and
expected_version when the copy should later replace that Motif. ZIP and empty
sources create app-owned editable drafts; an empty draft is a 960×540 canvas,
5 s long, with no props. Draft ids end in `-draft`, so the name's own id stays
free for the draft's first publication. A draft made by an earlier release may
hold its name's id itself; that is not a conflict for its own proposal, and
approving its first publication moves the draft to `<id>-draft` (its linked
folder stays linked) and publishes under the name's id. The draft row reports
the move as publication's renamed_draft; if `<id>-draft` is taken, the
approval is refused naming the holder and nothing changes.

## Without a shared folder

When the app cannot read the agent's folder, edit an app-owned draft through
the tools. read_motif with an id returns manifest, status, revision and file
inventory (path, size, SHA-256); it does not dump code or binary content. With
path, a UTF-8 file returns its text (up to 256 KiB; a larger text file is
refused, not truncated) and a binary file returns only its size and SHA-256.
The in-app HTML editor submits its HTML and manifest together through the same
file transaction.

Small binary assets go inline: an update_motif_files entry `{path, base64}`
carries the whole file as canonical base64, at most 256 KiB decoded per entry
and 4 MiB per call; invalid base64 is refused. Anything larger travels as a
package: a directory draft, or a ZIP the app can read (`{kind:'zip', path}`).

Batch edits through update_motif_files:

```json
{
  "motif_id":"my-motif-draft",
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
each `old` must occur exactly once in the text the previous edit left, or the whole batch is refused
with the edit's number; read the file again and resend. Prefer edits to
resending a file you have already written; creating a file still takes text.
The complete resulting package is validated before writes. Stale revisions
fail; read again and merge instead of blindly retrying. Linked drafts write
changes back to their source folder and commit one application snapshot.
Source write failures are rolled back, but the source folder is not a
transaction the app controls: external editors should save atomically and
avoid concurrent multi-file writes during an update.

## Review, publication and export

preview_motif takes 1–24 times (local_t_s, seconds from the Motif's start,
not timeline time) and returns one labelled PNG contact sheet, plus the exact
revision and the canvas and frame sizes. Each frame is the whole canvas at its
own size scaled to fit width and height (640 wide when neither is given; at
most 2×, aspect kept, never cropped); frames keep their transparency. It reads
and refreshes only the Motif it renders. Supply expected_revision to insist on
a previously read version.

Publication waits for the user. install_motif requires motif_id (the draft)
and the reviewed expected_revision, and only proposes: it freezes that
revision and answers awaiting_approval with a proposal id and its target, an
installed Motif's id and version or a new id. The library is untouched. The
user sees a card in the app's Motifs panel with the proposed package in the
preview player, its props, what changed against the installed version, and
the clips of the open project that will rebind; a small note in the status
bar points to it. Approve publishes the frozen revision, as a new version of
the target, and rebinds the trial layers; Reject keeps the draft and stores
the user's note. Tell the user the proposal is waiting and stop; list_motifs
shows the outcome on the draft's row as publication (state, note, version, and
for an approval the rebound layers with the props each one dropped), and the
catalog's list-changed notification fires on every change. Proposing again
from the same draft supersedes the older proposal; the same revision and
target again is the same proposal.

A first publication takes its id from the manifest name. If an installed
Motif, a built-in, a draft or another pending proposal holds that id, the
proposal is refused with the holder and the ways forward: rename the draft, or
replace the installed Motif with target_id and expected_version from
read_motif. Nothing is renamed with a number. Later proposals from the same
draft target its last publication, with a version conflict check. Built-ins
cannot be replaced. Published content is a snapshot independent of later
draft edits; edits made after proposing are not in the proposal.

export_motif writes a complete ZIP to path, which is required: an absolute
local `.zip` path in an existing folder; an existing file is refused, never
overwritten. It accepts expected_revision. A stale expected_revision on any
tool is refused with the current revision. Deleting a draft removes app-owned
data, its pending proposal and its association, never linked author files.

Captures pin companion URLs under a revision path, so a source edit cannot
swap assets midway through a capture. Only a bounded number of revisions stay
pinned; a request for an evicted stale revision fails and needs a catalog
refresh, rather than rendering new bytes under an old hash.
