# Motif workspaces and file transfers

The eight Motif tools are list_motifs, open_motif_draft, read_motif,
update_motif_files, preview_motif, install_motif, export_motif and delete_motif.
The previous HTML-only creation/amendment, ZIP import and draft-only preview
tool names have been removed, without compatibility aliases.

## Local directory workflow

```json
{"source":{"kind":"directory","path":"C:/work/title-overlay"}}
```

Pass this to open_motif_draft. The directory contains index.html and a
manifest.json (authoritative when present), or an HTML manifest island, plus
all runtime assets. Use a package/output folder, not an entire repository with
node_modules. Paths must be portable; links/junctions are refused. The package
is bounded to 256 MiB and 10,000 files. All resource URLs should be relative.

The result contains draft_id and revision. Reopening the canonical directory
returns its existing draft. Save files normally: the app watches the folder and
validates/copies stable content into its own rendering snapshot. It does not
inject ids into or move the source directory. Invalid changes retain the last
valid snapshot with an explicit diagnostic; preview, publication and export
must not silently approve that stale content. read_motif also refreshes before
answering. Deleted/unavailable directories report diagnostics and can recover
when restored.

Other mutually exclusive source variants:

```json
{"source":{"kind":"motif","id":"countdown"}}
{"source":{"kind":"zip","path":"C:/work/package.zip"}}
{"source":{"kind":"zip","file_id":"<completed upload id>"}}
{"source":{"kind":"empty","name":"My Motif"}}
```

Copying a publication or built-in creates a draft without choosing a publication
target. Opening an existing draft returns that draft. ZIP and empty sources
create app-owned editable drafts. Binary formats have no special tool names.

## Remote/file-only workflow

read_motif with an id returns manifest, status, revision and file inventory
(path, size, SHA-256); it does not dump all code or binary content. With path
and encoding="text", it returns UTF-8 text up to 256 KiB. Omit encoding (or use
"file") for a temporary downloadable file_id. The in-app HTML editor submits
its HTML and manifest together through the same file transaction.

Upload arbitrary files with begin_file_upload (size and lowercase SHA-256),
then write_file_chunk (file_id, offset, canonical base64). Chunks are at most
256 KiB decoded and contiguous; identical retries are accepted. Completion is
automatic at the declared size, and SHA-256 must match before attachment.
read_file_transfer returns a bounded base64 range, next_offset, eof,
received_bytes and complete. It also reports progress after a dropped upload
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
    {"path":"assets/model.glb","file_id":"<completed upload id>"},
    {"path":"assets/old.png","delete":true}
  ]
}
```

Each entry has exactly one content/delete operation. The complete resulting
package is validated before writes. Stale revisions fail; read again and merge
instead of blindly retrying. Linked drafts write changes back to their source
folder and commit one application snapshot. Source filesystem write failures
are rolled back; external editors should save atomically and avoid concurrent
multi-file writes during an update. The source folder is not a filesystem
transaction controlled by the app.

## Review, publication and export

preview_motif returns a PNG plus the exact revision. Supply expected_revision
to insist on a previously read version. Dedicated Workers, codecs and the
absolute-time frame contract are unchanged.

install_motif requires draft_id and the reviewed expected_revision. First
publication creates a distinct installed id; the draft remains. Subsequent
publications update its recorded publication, with a version conflict check.
To replace a different publication, supply target_id and expected_version from
read_motif. Built-ins cannot be overwritten. The same successful revision and
target can be retried without bumping the version; placed trial layers rebind
to the publication. To create a separate publication, first copy the draft's
ZIP into a new draft. Source provenance never implicitly chooses an overwrite.

export_motif produces a complete ZIP and returns a downloadable file_id, or
writes an absolute local path. It accepts expected_revision. Draft deletion
removes app-owned data and its association, never linked author files.
Published content is a snapshot independent of later draft edits.

Rendering pins companion URLs under a revision path for a navigation. A source
edit cannot replace assets midway through that capture. Snapshots retained in
memory are bounded; requesting an unavailable stale revision fails and requires
a catalog refresh, rather than rendering new bytes under an old hash.
