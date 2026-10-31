---
status: accepted
---

# Reuse is decided in one place, from current facts

Date: 2026-10-29

## Context

An audit after v0.5.4 found four defects of one kind, each answering a request
with an existing thing that did not answer it:

- **Import.** A pooled file was overwritten outside the app, then its backup
  imported: the hashes matched and the item's file existed, so the item was
  answered while playing other bytes. The decision had been patched six times,
  one branch per kind of stale fact, each choosing its own amount of checking.
- **Late copy.** A source renamed over after `import_media` returned was copied
  as it then stood; the item adopted the copy's hash and silently changed
  bytes, and a late thumbnail cached the new picture under the old hash.
- **Hardware probe.** A VideoToolbox probe requested during another was refused
  as busy, and the caller fell back to software decoding.
- **Clip jobs.** `describe_clip` gained `refresh` but the hand-listed
  singleflight key did not, so a refresh joined a plain run and never ran.

## Decision

Joining, reusing or caching claims that an existing thing answers this request.
Each claim is made in one place that names everything it depends on.

- **One decision, re-asked after every await.** An import's match is
  `importSource.nextImportStep`, a pure function of the pool and facts read so
  far; the final decision runs in the turn of its write (ADR 0151).
- **A recorded fact is verified before it is answered.** An item is reused only
  if its own file holds the recorded bytes now (the source itself, just read, or
  its file read again). Size, mtime and file number are not enough.
- **Contention is not an answer.** A one-at-a-time resource queues callers
  instead of refusing them. The decode probe process (`decodeProbeProcess.ts`)
  runs probes in turn; a caller waits for the previous caller's answer, not its
  child's exit.
- **Every input is classified, by a test.** `clipJob.ARG_ROLES` gives each
  clip-compute arg a role (`answer` and `fresh` are in the key, `span` is read
  through the source); a test holds the roles to the MCP catalog snapshot.
- **Contracts are tested as properties.** `mediaImport.model.test.ts` drives
  imports, overwrites, deletions and queued copies over a model file system and
  checks that every answered item's file holds the source's bytes and no settled
  hash changes.

Pool files changed outside the app:

- **`Media/` is the app's own; a file there is never rewritten.** After its copy
  lands, an item reads only a file the app wrote. A source outside the project
  is read only until then.
- **A copy is the item's file only if it holds the recorded bytes.** The
  workspace-copy write-back compares hashes; a mismatched copy is deleted and
  the item keeps its source path.
- **One stat screens every pool file** (`state/sourceFiles.ts`) against the
  item's `file_size`/`file_mtime`; no field is added to `project.json`. Missing:
  missing. Different size: `changed`. Different mtime only: bytes are hashed
  once in the background, one file at a time; a match records the new mtime.
  The summary rebuilds on every publication and on window focus.
- **`changed` is unavailable, like missing.** The pool shows a Changed badge;
  nothing is deleted. Importing the original again relinks by bytes; importing
  the new file makes a new item. Swapping media behind placed clips is a
  separate command (issue #88).
- **Every reader of source bytes checks first.** MCP tools that read a source
  (clip compute, `analyze_audio`, `compare_frames`) refuse changed or missing
  ones; open-time derivative fan-out and import recovery skip them. Each native
  derivative job (`jobs::run_derivative`) stats the source first, hashes it when
  the stat differs from the record, stats again after generating, and discards
  the output if the source changed meanwhile.

## Consequences

- Importing bytes a pooled item records reads that item's file once more; a
  queued hardware probe can wait out the previous one's deadline; a refresh runs
  beside a plain run (ADR 0147's per-file lock keeps their writes apart).
- Accepted residual risk: a same-size replacement within the same mtime second
  passes the stat. Only a time-preserving tool can do that, and importing such a
  file still reads its bytes.
- New reuse points follow the same rule: write down what makes a reused answer
  valid, check it in one function, test that function's contract.
