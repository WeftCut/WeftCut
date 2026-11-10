---
status: accepted
---

# A Motif package's revision is remembered by its file stamps

Date: 2026-11-11

## Context

A package's revision is the SHA-256 of its manifest, page and every companion's
bytes ([ADR 0079](0079-motifs-bundle-local-resources-and-hash-the-package.md)).
It keys stored frames and covers, so it must change whenever a byte does.

Nothing kept it. Every consumer read the whole package and hashed it again:

- the catalog listing, for each installed Motif and draft, on every call: at
  launch from the actor, from the renderer, from the watcher's first signal and
  from the picker;
- a draft linked to a directory, on every listing: its package once for the
  old revision, the directory twice to see that no save crossed the read, and
  its package again before deciding whether to write;
- a cover request, twice, cache hit or not;
- a capture host's pin, on every build.

All of it is synchronous on the main process. With text Motifs the packages are
a few kilobytes. A model, its textures and a 3D library make one tens of
megabytes, and the cost follows the bytes: on a 2-core Linux box, five installed
packages of 41.5 MB and one linked directory of 40 MB took 1.7–1.9 s per
listing and 0.95 s for six cover lookups, each time, page cache warm.

The user store is edited by hand as well as by the app: a file saved into
`<dataRoot>/motifs/<id>/` must re-render the Motif, as before.

## Decision

- **The revision's definition does not change.** Stored frames and covers keep
  their keys.
- **A record keeps what a directory's bytes came to**, against the stamps of
  its files: path, size, modification time, change time and file id of each
  (`PackageRevisions`, `main/motif/packageRevisions.ts`). A question about a
  package stamps its directory and answers from the record when every stamp is
  the recorded one. Otherwise the package is read and hashed once, and
  recorded. Stamping is the walk a read makes, with the same refusals (links,
  unportable paths, the package limits), without the bytes.
- **A stamp must have settled to be recorded.** A file modified or changed less
  than 2 s before its stamp was taken can change again without its times
  moving (FAT keeps modification times in 2 s steps), so such a stamp is not
  recorded and the package is read again next time. This is git's rule for its
  index. A package the app has just written is therefore read once or twice
  more, then no more.
- **A read belongs to a stamp only if the stamp still holds after it.** The
  directory is stamped before and after its bytes are read. For a linked
  directory a difference refuses the read, as the two full reads did. For a
  store package the bytes are hashed and the answer is not recorded.
- **Every consumer asks the store.** The listing, `read_motif`, covers and
  pins take the revision from `UserMotifStore` (`describe`, `packageSnapshot`,
  `pinPackage`). A pin still reads the bytes it will serve, and no longer
  hashes them when their stamp is recorded. A built-in's revision is computed
  once per process.
- **A linked directory records its outcome**: the revision its files
  normalised to, or the diagnostic that refused them. A listing skips the
  directory when its stamp is recorded and, for a revision, the draft's
  app-owned package still holds it. Only what the files decide is recorded: a
  failed read or write is tried again.
- **Records are derived data.** They sit in
  `<dataRoot>/cache/motif-revisions.json`, keyed by directory, written whole
  and atomically. A record of another app version is dropped, so a release that
  hashes or validates differently reads every package once. A missing,
  unreadable or unwritable file costs reads, never an error.

## Consequences

- On the same box and packages: the first listing 1.2 s, later ones 2–4 ms,
  six cover lookups 2 ms, and the same after a restart.
- On a Windows 11 desktop (NTFS, real-time scanning on), twenty installed
  packages of 42 MB and three linked ones: a listing went from 1.8 s to 27 ms,
  and the app answered its first catalog request 1.1 s after launch against
  1.9 s.
- What remains is one stat per file per listing. Nine packages of 2,500 files
  each list in 0.2 s on the Linux box and 0.8 s on the Windows one (1.7 s and
  7.6 s before): a stat costs about 30 µs there. A package near the limits,
  9,500 files and 236 MB, lists in 0.07 s and 0.19 s.
- The first launch after an update, and after the cache is cleared, reads
  every package once.
- A file whose modification time lies in the future keeps its package unsettled
  until that time passes: correct, and as slow as before.
- An edit that restores a file's size, both times and id is not seen. Change
  time is set by the file system, so this takes a file system without one, or
  a clock set back.
- The hand-edited store keeps working without a rule about who may write it:
  the stamp walk is what sees those edits.
- A pin still holds a package's bytes in memory per revision. Serving pinned
  revisions from disk is a separate change.
