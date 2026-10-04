---
status: accepted
---

# Motif directory workspaces and file operations

Date: 2026-10-04

## Decision

Replace the fragmented HTML-only creation, amendment and ZIP import interfaces
with one open_motif_draft entry accepting directory, Motif, ZIP or empty sources.
Remove old MCP and IPC tool names; there are no compatibility aliases. This
explicitly supersedes the import-only snapshot workflow in ADR 0079 and the
import_motif naming in ADR 0093. The complete package remains the portable unit.

Directories are live authoring sources, not protocol filesystem roots. The app
keeps validated rendering snapshots, reports invalid source diagnostics and
uses revision-specific resource paths during capture. Same-directory opens
reuse identity. Copy provenance does not choose a publication target.

read_motif and update_motif_files cover all text/binary companions. Updates
require an expected revision and validate the complete batch. Generic bounded
file transfers cover clients without shared filesystem access; there is no
model- or texture-specific tool. Reads and exports are downloadable, so uploaded
content remains editable and portable.

Publication requires a reviewed revision, retains the editable draft and creates
a separate installed identity. Further updates check the installed version;
retries of the same publication do not bump it. This replaces the prior store
move/consume lifecycle. Removing a linked draft never removes its source.

## Consequences

Both desktop UI and MCP use the same workspace operations. The library remains
app-scoped; timeline placement and version acknowledgement remain project
operations. Existing installed packages and on-disk drafts remain readable;
clients must use the new interfaces. A separate copy can be made by exporting
and reopening a ZIP, without adding another creation tool.

Directory watchers provide live refresh; reads/preview/publish/export recheck
the source. Application-owned snapshots are replaced as complete directories.
Author-directory writes have rollback, but cannot provide a cross-process
filesystem transaction against an independently writing editor. Package limits,
path validation and the offline CSP remain in force.

Tests cover directory identity and recovery, revision conflicts, binary transfer
round-trips, retained publication, resource pinning, removed-tool refusal and
actual Electron preview/export. The shipped skill teaches the same workflow.
