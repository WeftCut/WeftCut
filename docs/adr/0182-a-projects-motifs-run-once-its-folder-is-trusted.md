---
status: accepted
---

# A project's Motifs run once its folder is trusted on this machine

Date: 2026-11-25

## Context

ADR 0174 lets a project Motif run only when its revision is trusted here, and
the user trusts one revision at a time on a card in the Motifs panel. The
user's own projects ask too: a project folder synced to a second machine, a
pack opened there, Motifs edited while the app was closed, an upgraded
project. Each untrusted Motif takes a row selection and a click, and nothing
says so at open; the user meets it as a layer that does not draw or an export
that refuses.

Folder-based tools settle the same question by place rather than by content:
a trusted folder runs what it holds, later changes included, and a new folder
asks once.

The Motif sandbox is narrower since capture hosts got a partition of their own
that refuses the network in the browser process (docs/security.md), but it is
still not hardened against a renderer exploit, so trust stays the gate on
whether a project Motif runs at all.

## Decision

- **The unit of trust is the project folder.** Trusting a project trusts
  every writer of its folder: the user, their agents, a sync service, and
  whoever else can write there. Every revision under a trusted folder runs,
  whatever brought it: a sync, an edit made while the app was closed, an
  agent's write, a ZIP import, a backup put back. No per-revision record is
  written for it.
- **The record stays on this machine.** `<dataRoot>/motifs/.trust.json`
  keeps `revisions` and gains `projects` (folder → trusted at) and
  `dismissed` (folder → dismissed at). Its version stays 1: an older build
  reads the revisions and ignores the new keys (and drops them on its next
  write, so a project asks once more) instead of setting the whole record
  aside as unreadable. A folder is keyed by its canonical path
  (`realpath.native`), so a moved or renamed folder is another project and
  asks once; Save As carries the trust to the folder it makes. The project
  holds nothing about trust: whoever sends a project writes everything in it.
- **Untrusted projects keep ADR 0174.** Revisions from this machine's library,
  Motifs made here and edits made while the project is open are trusted as
  before; everything else waits for the project's trust.
- **One dialog decides, shown once per folder.** When a project opens holding
  at least one untrusted Motif, and its folder is neither trusted nor
  dismissed here, the app asks: *Run this project's Motifs?*, with the count,
  a collapsed list (id, files, size; WebAssembly, Workers and minified code
  only when present, read as text by `trustSummary.ts`), *Later* and *Trust
  this project*. *Ask an agent to check first* copies a prompt that reads the
  untrusted Motifs with `read_motif` and runs nothing. Trust sends the
  revisions the dialog showed; if a folder holds another by then, nothing is
  trusted and the list shows what the folders hold now.
- **Later is remembered.** The dialog never opens by itself again for that
  folder, new untrusted Motifs included. The same dialog opens from the Motifs
  panel's project group, from *File > Trust this project…* and from the
  property panel's lead on an untrusted layer. When the project is trusted,
  the menu item reads *Stop trusting this project* and acts at once; the
  dialog then stays dismissed, and the Motifs that only the folder made
  trusted stop running.
- **The per-Motif trust card is gone.** The project is the only unit the user
  trusts; `trust_motif` is replaced by the project channels.
- **Only the user trusts.** The trust, untrust and dismiss channels are
  renderer-only, never MCP tools. `project://session` tells an agent whether
  the project is trusted and lists its untrusted Motifs.
- **A trusted project stays quiet.** Motifs whose revision changed while the
  app was closed get one log row at open; nothing else is shown.

## Consequences

- One click covers a stranger's project as easily as the user's own: the app
  cannot tell them apart, and trusting a received project trusts its later
  updates in that folder too.
- A project received from someone else can no longer be trusted Motif by
  Motif. A Motif copied out of a trusted project into an untrusted one asks
  there.
- A shared folder (a cloud drive several people write) is trusted as a whole:
  trusting it trusts every member and anyone else with write access.
- ADR 0174's rejection of trust per project is withdrawn for folders: the
  same bytes are the same risk anywhere, but asking per revision proved too
  heavy for the user's own projects, and the folder names who writes, which
  the bytes do not.
- A list of trusted projects in Settings is deferred; the File menu covers
  the open project. Deleting `.trust.json` still forgets every trust.

## Later: trust by author

When several people edit one project, folder trust cannot trust some writers
and not others, say who changed a Motif, or carry trust to a new folder (an
author's next pack). That needs author identity: a per-user signing key paired
across the user's machines, the app signing the revisions it writes, and trust
in members' keys instead of a folder. Unsigned or unknown-signed changes would
still ask. This ADR keeps that open:

- one gate decides whether a revision runs (`MotifResolver.projectTrusted`);
  an author check joins it there;
- a revision is the hash of every byte, which a signature can sign as it is;
- trust is recorded on this machine, never in the project; a project would
  carry only signatures, checked against keys held here;
- the record keeps one key per scope (`revisions`, `projects`), so an author
  scope is a new key, not a migration.

The hard part is known: the app cannot tell an edit the user made while it
was closed from one a sync brought, so it may sign only revisions it saw
written while open. Building this waits for multi-user editing.

Rejected: a trusted parent folder (downloads and unpacks land under it);
asking again when new code reaches a trusted project (the user's own edits
and syncs would ask constantly); trusting by the cloud drive's "modified by"
(per-provider, and not readable from the local file system).
