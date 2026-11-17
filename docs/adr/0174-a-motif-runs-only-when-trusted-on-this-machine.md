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
  | `created` | `create_motif` empty, a copy of a trusted Motif, or a folder under `Motifs/` adopted in place | trusted, unless these bytes were found untrusted at an open |
  | `imported` | `create_motif` from a ZIP or a directory outside `Motifs/` (the panel's Import Motif too) | trusted when the files as they came (their revision under the id they carry) are, as a ZIP this library exported is even when the project holds that id and the copy takes another; otherwise nothing |
  | `edited-while-open` | the watcher, the source panel or `update_motif_files` records a new revision of a tabled Motif, or any surface reads one the watcher has not heard yet (`MotifResolver.projectTrusted`, from the revision the table records) | trusted when the revision it was made from is, and the result was not found untrusted at an open |
  | `opened` | the project becomes the open one | remembered as found when not trusted |

  A materialization that kept a folder holding other bytes than it was given
  reports `opened`, not its own cause: it made nothing.
- **Found at open, before anything can hear an edit.** `MotifResolver.setProject`
  sees every folder under `Motifs/` (tabled or not) as `opened` as the project
  becomes the open one, before its watcher starts and before the open records
  a folder changed while it was closed. The found set is kept for the app's
  session, not per project, and holds at most 20,000 revisions: the same bytes
  found in a second project are as foreign.
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
  open reads as an edit made here.
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
trust per project (the same bytes are the same risk anywhere); an MCP tool
that trusts (an agent could approve code it was handed); running an untrusted
Motif in a stricter sandbox instead (the sandbox is what is not hardened).
