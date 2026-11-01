# Motif workspaces

The Motif tools are list_motifs, open_motif_draft, read_motif,
update_motif_files, preview_motif, install_motif, export_motif and
delete_motif. They take paths and inline text; no tool is specific to a file
format or model type.

## Local directory workflow

```json
{"source":{"kind":"directory","path":"C:/work/title-overlay"}}
```

Pass this to open_motif_draft. The directory contains index.html and a
manifest.json (authoritative when present), or an HTML manifest island, plus
all runtime assets. Use a package/output folder, not an entire repository with
node_modules. Paths must be portable; links/junctions are refused. The package
is bounded to 256 MiB and 10,000 files. All resource URLs should be relative.

The result contains draft_id and revision. Reopening the same directory
returns its existing draft. Save files normally: the app watches the folder and
validates/copies stable content into its own rendering snapshot. It does not
inject ids into or move the source directory. Invalid changes keep the last
valid snapshot with an explicit diagnostic; preview, publication and export
refuse that stale content rather than approving it. read_motif refreshes before
answering. A deleted or unavailable directory reports diagnostics and recovers
when restored.

Other mutually exclusive source variants:

```json
{"source":{"kind":"motif","id":"countdown"}}
{"source":{"kind":"zip","path":"C:/work/package.zip"}}
{"source":{"kind":"empty","name":"My Motif"}}
```

Copying a publication or built-in creates a draft without choosing a
publication target. Opening an existing draft returns that draft. ZIP and empty
sources create app-owned editable drafts.

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
  "draft_id":"my-motif",
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

preview_motif returns a PNG plus the exact revision and the canvas and image
sizes. It always renders the whole canvas at its own size; width and height
only bound the returned image, which is scaled to fit (at most 2×, aspect
kept, never cropped). Supply expected_revision to insist on a previously read
version.

install_motif requires draft_id and the reviewed expected_revision. First
publication creates a distinct installed id; the draft remains. Subsequent
publications update its recorded publication, with a version conflict check.
To replace a different publication, supply target_id and expected_version from
read_motif. Built-ins cannot be overwritten. The same successful revision and
target can be retried without bumping the version; placed trial layers rebind
to the publication. To create a separate publication, first copy the draft:
export_motif it to a ZIP path and open that ZIP as a new draft (the app's
"Save as new" copies in one internal step). Source provenance never implicitly
chooses an overwrite.

export_motif writes a complete ZIP to path, which is required: an absolute
local `.zip` path in an existing folder; an existing file is refused, never
overwritten. It accepts expected_revision. Deleting a draft removes app-owned
data and its association, never linked author files.
Published content is a snapshot independent of later draft edits.

Captures pin companion URLs under a revision path, so a source edit cannot
swap assets midway through a capture. Only a bounded number of revisions stay
pinned; a request for an evicted stale revision fails and needs a catalog
refresh, rather than rendering new bytes under an old hash.
