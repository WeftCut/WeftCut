---
status: accepted
---

# A file the pool holds is imported once

Date: 2026-10-28

## Context

Every import copied its source into `Media/` without asking whether the pool
already held it: re-importing `<project>/Media/take.mp4`, or the same outside
file twice, added a second item and a second `Media/<prefix>-take.mp4`. With
the project folder as an agent's working directory (ADR 0152), an agent turns
each mentioned file into an `import_media` call, so repeat imports of pooled
files are the normal path. Path comparison cannot decide "same file": NTFS holds
an NFC and an NFD `café.mp4` side by side, and an overwrite can keep the file
number, size and second-resolution mtime.

## Decision

- **The pool is checked in the turn that inserts.** After the probe,
  `import_media` looks for an item that is the source. Two paths are one file
  when a stat gives the same volume and file number; a file system without file
  numbers compares real paths as spelled. Joining an import in flight also
  requires the probe's size and mtime to match; a settled item is matched by
  content. The check and the insert share one synchronous turn, so racing
  imports of one file land one row; the later waits for the earlier to settle.
  A match writes nothing and answers the held id; the import diagnostic ends
  `already_in_pool`.
- **A source already under `Media/` (any subfolder) is recorded in place**
  with its `Media/`-relative `path_rel`; no copy is queued.
- **Anything else is copied into `Media/`**, inside the project folder or not,
  so every pooled file lives under `Media/` and `path_rel` has one shape.
- **Same bytes are matched by hash before the insert.** When an item with a real
  hash has the source's byte size, the source is hashed first and the import
  reuses that hash. An item whose hash is still pending cannot match: two
  imports of the same bytes racing from two paths land two rows, and the MCP
  record names the other in `same_content_as`.
- **An item answers only while its own file holds the recorded bytes** (the
  source itself, just read, or its file read again — ADR 0153). Of several
  items recording the bytes, one whose file still holds them answers.
- **Found bytes relink an item whose file no longer holds them** (copy deleted,
  overwritten, drive offline): the first such item is pointed at the source,
  copied into `Media/` and its derivatives regenerated. It keeps its id, so its
  layers play the bytes they were placed with. Racing relinks happen once.
- **The MCP record says what happened:** `existing: true` for an item held
  before the call, `relinked: true` for a relink. UI and MCP share the
  importer; renderer IPC returns only the media id.

`importSource.nextImportStep` is the one decision (join, hash, verify, reuse,
relink, add). `mediaImport.ensureImported` gathers facts, asks again after every
await, and checks the session generation after copy enqueue before reporting.
`mediaImport.model.test.ts` holds the contract under random overwrites,
deletions and imports. One `MediaImporter` per actor owns the in-flight
registry; a result does not promise derivatives or copying finished.

## Consequences

- `import_media` is how any path becomes the media id the app already uses.
- A deliberate second copy of pooled bytes is not a second item.
- A source whose size matches a pooled item appears only after it is hashed.
- Removing a pool item never deletes its file, so in-place records are as safe
  as copies.
