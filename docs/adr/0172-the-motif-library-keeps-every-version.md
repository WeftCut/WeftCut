---
status: accepted
---

# The Motif library keeps every version; delete goes to the trash

Date: 2026-11-17

## Context

An installed Motif lived at `<dataRoot>/motifs/<id>/`. Approving a
replacement, or the user's own Update, removed that folder and wrote the new
version in its place, and Delete removed it for good. A bad update, by an agent
or by the user, could not be undone, and a deleted Motif was gone. A project
that carries its own copies of Motifs (the portable project) needs the
library's versions to stay put, so that "the version this project was made
with" still exists.

## Decision

- **One folder per version.** Version `n` of installed `<id>` lives in
  `<dataRoot>/motifs/<id>/v<n>/`, where `n` is the manifest version written
  into it. The current version is the highest `v<n>` holding an `index.html`.
  Every read of an installed Motif (catalog, protocol, covers, capture pins,
  export, copies) resolves through one store function
  (`UserMotifStore.currentRel`, `main/motif/store.ts`); an older version is
  never served as the Motif.
- **Saving adds a version, never writes over one.** Approval, the user's
  Install / Update and a restore write the package into a staging folder in
  `<id>/` and rename it to `v<n+1>/`, `n` being the highest version folder,
  packaged or not. An existing version folder is refused. Drafts and frozen
  proposals are still replaced whole: they are not the library.
- **Restore adds a version.** Version history on the library card lists the
  versions, newest first; restoring `vN` publishes its files again as the
  newest version, through the same path as a replacement publication, so the
  open project's clips rebind as an approval rebinds them. It is the user's
  alone: no MCP tool restores or lists versions. Built-ins have no history.
- **Delete moves to the system trash** (`shell.trashItem`): the whole `<id>/`
  folder with every version, and the draft folder. When the trash refuses, the
  delete is refused and nothing moves; files are never removed for good.
- **Keys stay.** A version folder is written once, so its revision record
  (ADR 0164) is keyed by the folder and stays valid. The lineage (ADR 0171)
  stays keyed by `<id>`: one lineage for all versions.
- **Format 2.** The first launch of a format 1 store moves each
  `<id>/index.html` package to `<id>/v<its manifest version>/` (`v1` when the
  manifest does not parse), through `.versioning-<id>` in the store root, and
  finishes a move a crash interrupted. Revision records move with the
  folders. It writes `2` to `motifs/.format` only after every move; a move
  that fails is tried again at the next launch. A later launch decides by the
  marker, never by sniffing folders: an author's package may hold a `v1/`.

## Consequences

- The library grows with every publication. Nothing prunes old versions yet.
- Revisions, and therefore stored frames and covers, keep their keys across
  the migration and across a restore of identical files.
- A Motif restored from the system trash by hand comes back with all its
  versions, but with a new lineage: deleting through the app forgets it
  (ADR 0171).
- Until projects carry their own copies, a deleted Motif's clips show the
  missing-Motif placeholder; the delete confirmation says so.
- No MCP tool or field changes; `delete_motif` now moves to the trash.

Rejected: a hidden history folder beside the current version (two layouts for
one Motif, and the current one is still overwritten); a `current` pointer file
(a second source of truth that can disagree with the folders); removing the
folder when the trash is unavailable (a delete that cannot be undone is what
this replaces).

## Note (2026-11-17): saving to the library changes no project

Projects now hold copies of their Motifs
([ADR 0173](0173-the-project-folder-holds-what-it-renders.md)). Approval, Save
to library and restore add a library version and rebind no clip; projects of
that lineage show *update available*. Deleting a library Motif leaves every
project's copy in place. Drafts are gone, so delete moves the Motif's version
folders only.
