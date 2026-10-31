# Motif workspaces and file transfers

The Motif tools are list_motifs, open_motif_draft, read_motif,
update_motif_files, preview_motif, install_motif, export_motif and
delete_motif, plus the generic transfers begin_file_upload, write_file_chunk,
read_file_transfer and delete_file_transfer. No tool is specific to a file
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
{"source":{"kind":"zip","file_id":"<completed upload id>"}}
{"source":{"kind":"empty","name":"My Motif"}}
```

Copying a publication or built-in creates a draft without choosing a
publication target. Opening an existing draft returns that draft. ZIP and empty
sources create app-owned editable drafts.

## Remote/file-only workflow

read_motif with an id returns manifest, status, revision and file inventory
(path, size, SHA-256); it does not dump code or binary content. With path and
encoding="text", it returns UTF-8 text up to 256 KiB. Omit encoding (or use
"file") for a temporary downloadable file_id. The in-app HTML editor submits
its HTML and manifest together through the same file transaction.

Upload files with begin_file_upload (size up to 256 MiB, lowercase SHA-256),
then write_file_chunk (file_id, offset, canonical base64). Chunks are at most
256 KiB decoded and contiguous; identical retries are accepted. Completion is
automatic at the declared size, and SHA-256 must match before attachment.
read_file_transfer returns a bounded base64 range, next_offset, eof,
received_bytes and complete; it also reports progress after a dropped upload
response. Transfers survive restart, expire after 24 hours and reserve at most
512 MiB / 64 files. delete_file_transfer releases storage; attached files have
already been copied into the draft.

Batch edits through update_motif_files:

```json
{
  "draft_id":"my-motif",
  "expected_revision":"<revision just read>",
  "files":[
    {"path":"scene.js","text":"/* replacement source */"},
    {"path":"index.html","edits":[{"old":"font-size: 56px","new":"font-size: 48px"}]},
    {"path":"assets/model.glb","file_id":"<completed upload id>"},
    {"path":"assets/old.png","delete":true}
  ]
}
```

Each entry has exactly one operation: text (the whole file), file_id, edits or
delete. Edits change part of an existing UTF-8 file: each `old` must occur
exactly once in the text the previous edit left, or the whole batch is refused
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
to the publication. To create a separate publication, first copy the draft's
ZIP into a new draft. Source provenance never implicitly chooses an overwrite.

export_motif produces a complete ZIP and returns a downloadable file_id, or
writes an absolute local path. It accepts expected_revision. Deleting a draft
removes app-owned data and its association, never linked author files.
Published content is a snapshot independent of later draft edits.

Captures pin companion URLs under a revision path, so a source edit cannot
swap assets midway through a capture. Only a bounded number of revisions stay
pinned; a request for an evicted stale revision fails and needs a catalog
refresh, rather than rendering new bytes under an old hash.
