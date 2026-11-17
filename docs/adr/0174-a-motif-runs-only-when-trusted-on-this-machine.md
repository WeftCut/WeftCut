---
status: accepted
---

# A Motif runs only when trusted on this machine

Date: 2026-11-18

## Context

A project now carries the Motifs it renders, as folders under `Motifs/`
([ADR 0173](0173-the-project-folder-holds-what-it-renders.md)). A Motif is
code: an HTML page with scripts, Workers and WebAssembly that the app runs in
an offscreen capture window to draw frames, and that runs again for previews,
bakes and covers. Opening a project received from someone else would run its
code at once, before the user had looked at anything. The Motif sandbox (no
preload, no Node, the `motif:` CSP, [security.md](../security.md#motif-documents))
bounds what that code reaches, but it is not hardened against a renderer
exploit, so the sandbox alone should not be what stands between a received
file and the user's machine. ADR 0173 names this as its consequence: trust
ships with it.

## Decision

- **Trust is per revision, recorded on this machine.** A revision is the hash
  of every byte of a package (ADR 0164), so trusting one trusts exactly those
  bytes, in any project. The record is `<dataRoot>/motifs/.trust.json`
  (`{version: 1, revisions: {<sha256>: [trusted at ms, cause]}}`,
  `main/motif/trust.ts`), beside the library, so a data-root move carries it.
  It keeps the newest 20,000 revisions; it is written whole aside and renamed
  into place, coalesced per event-loop turn, written at once on the user's
  Trust and flushed at quit. A record that does not parse is moved aside to
  `.trust.json.corrupt` and nothing in it is trusted.
- **The library is trusted by derivation, never by record.** Every built-in's
  bundled revision and every installed version's revision is trusted: the
  library grows only from what the user saved or approved here. `--library`
  and `--proposal` hosts are never asked about; a proposal is frozen from a
  project Motif that `install_motif` refuses when untrusted.
- **What seeing a revision earns** (`trustOnSeen`), by how the open project's
  store saw it:

  | Cause | Seen when | Earns |
  | --- | --- | --- |
  | `placed` | a library Motif is copied in | trusted, recorded even though the library holds it, so it stays trusted after that library version is deleted |
  | `created` | `create_motif` empty, or a copy of a trusted Motif | trusted, unless these bytes were found untrusted at an open |
  | `imported` | `create_motif` from a ZIP or a directory outside `Motifs/` (the panel's Import Motif too) | trusted when the files as they came (their revision under the id they carry) are, as a ZIP this library exported is even when the project holds that id and the copy takes another; otherwise nothing |
  | `edited-while-open` | the store observes a folder holding another revision than it last observed there: the watcher, the source panel's and `update_motif_files`' writes, adopting a folder under `Motifs/` in place, and any surface reading a revision not trusted yet (`MotifResolver.projectTrusted`) | trusted when the revision last observed in that folder is, and the result was not found untrusted at an open; nothing when the store observed none |
  | `opened` | the project becomes the open one, or a backup is put back in a folder (undo, redo, Review's revert) | remembered as found when not trusted |

  A materialization that kept a folder holding other bytes than it was given
  reports `opened`, not its own cause: it made nothing.
- **Positive evidence only.** An edit earns trust only from bytes this
  session itself saw in that folder: the store (`ProjectMotifStore`, one per
  open session) remembers the revision it last observed in each folder, set
  when the project opens and with each write, observation and put-back here.
  The revision the project's table records is never a base, nor is a folder
  that differs from it: whoever sent the project wrote the table. Reading
  surfaces (`list_motifs`, `read_motif`, `project://session`, export,
  resolving a host) apply this rule and nothing else, so a read grants no
  trust it would not grant the watcher.
- **Found at open, before anything can hear an edit.** `MotifResolver.setProject`
  sees every folder under `Motifs/` (tabled or not) as `opened` as the project
  becomes the open one, before the actor takes its table, before its watcher
  starts and before the open records a folder changed while it was closed.
  The open project's found revisions are all kept, however many folders it
  ships; those of projects opened before stay for the app's session, at most
  20,000: the same bytes found in a second project are as foreign.
- **A backup puts back only the revision it names.** `Backups/motifs/` comes
  with the project, so a record is checked against the files it maps: they
  must make the revision it is named for, or nothing is put back. Backing up
  a revision writes over a record that names other files. Bytes put back are
  heard as `opened`: an undo never makes an edit.
- **A folder is read under its exact name.** Only a folder whose name is a
  table key (lowercase letters, digits, single dashes) holds a package; any
  other is `invalid`, and a key is never read from a folder named in another
  case, as a case-insensitive file system would otherwise answer it.
- **One gate.** The resolver answers a project host whose revision is not
  trusted as `untrusted`, with its manifest and revision, and the protocol
  (`params.html` included), capture hosts, previews, bakes, covers and pins
  all resolve through it, so none loads one. Every surface that lists Motifs
  overlays the same state (`effectiveState`, judged by the resolver's
  `projectTrusted`): `list_motifs` rows,
  `project://session` (`motifs.untrusted`, each with the revision to trust),
  the export refusal (`MotifUnavailable` naming it). `preview_motif`,
  `create_motif` `copy`, `install_motif` and the user's Save to library refuse
  `MotifUntrusted {id, revision}`. `read_motif` and `export_motif` work: they
  read and write files and run nothing.
- **The user trusts on a card, from a static summary.** Selecting an untrusted
  row in the Motifs panel shows the trust card: file count and size, scripts,
  Worker and WebAssembly use, long minified lines and files too large to read,
  found by reading the bytes as text (`main/motif/trustSummary.ts`), never by
  loading them. One button, *Trust*, sends the revision the summary was read
  from; a folder that holds another by then is refused `RevisionConflict` and
  the card shows the files again. A layer on an untrusted Motif shows the same
  lead in the property panel with a link to the card.
- **Only the user trusts.** `motif_trust_summary` and `trust_motif` are
  renderer channels (router `MOTIF_CHANNELS`), never MCP tools. An agent reads
  an untrusted Motif with `read_motif` and leaves the decision to the user.

## Consequences

- Trust protects against code that arrives in a folder: a received project, a
  ZIP, a directory brought in, a folder changed while its project was closed.
  It does not protect against a local agent writing code: an agent editing an
  open project's Motifs writes trusted revisions, as its own tools already run
  on this machine. A sync service writing into `Motifs/` while the project is
  open reads as an edit made here. An agent that copies text it read from an
  untrusted Motif into a trusted one makes that code trusted: trust guards
  against code arriving in folders, not against what a local agent chooses
  to write.
- A folder an agent writes under `Motifs/` and then adopts asks for Trust:
  adopting makes none of its bytes here.
- A ZIP import asks, the user's own included, unless it holds bytes this
  machine already trusts (one exported from this library does).
- Edits the user makes by hand while the app is closed are found at the next
  open and ask for Trust like a received Motif.
- A received update of a trusted Motif is new bytes and asks again; a received
  project whose Motifs came from this machine's library asks nothing.
- Machines that share a data root through a synced folder share trust.
- There is no untrust in the app. Deleting `.trust.json` forgets every Trust;
  the library stays trusted.
- The sandbox is still the boundary for what runs (security.md); trust decides
  only whether a project Motif runs at all.

Rejected: trust by lineage (a ZIP claims any lineage it likes, ADR 0171);
trust recorded in the project (whoever sends the project would write it);
judging an edit from the revision the table records, or from its backups
(the same writer); trust per project (the same bytes are the same risk anywhere); an MCP tool
that trusts (an agent could approve code it was handed); running an untrusted
Motif in a stricter sandbox instead (the sandbox is what is not hardened).
