---
status: accepted
---

# A project travels as its folder or as one pack

Date: 2026-11-24

## Context

With media, Motifs, fonts and the extended style in the project folder
([ADR 0173](0173-the-project-folder-holds-what-it-renders.md),
[ADR 0175](0175-project-files-are-named-by-project-paths.md),
[ADR 0176](0176-a-project-collects-the-fonts-it-uses.md)), a copy of the folder
plays elsewhere. Two gaps remained:

- **Nothing said what the folder still lacked.** A missing clip, a Motif whose
  folder had gone, a font the user excluded from `Fonts/` or a style the folder
  did not hold showed up only on the other machine.
- **Handing a project over meant copying a folder by hand.** That copy carried
  the machine-local entries too: caches, backups, logs and exports, often
  larger than the project itself.

## Decision

- **The portability check** (`state/portability.ts`; File > Check portability,
  `project://portability`) lists what the open project needs from outside its
  folder:
  - media outside the folder, or missing;
  - Motifs whose folder is gone or holds no package;
  - fonts excluded from `Fonts/`, and fonts the project asks for that
    `Fonts/` does not hold, whether installed here or nowhere;
  - the style `TASTE.md` extends, when the folder lacks it.

  The check and the pack dialog first copy into `Fonts/` what the project
  draws and the folder lacks, as a pack does, so a face deleted from it or
  not yet copied is restored before the report; a copy that fails stays
  listed. The MCP view only reads.

  It names folders under `Motifs/` that no layer places, which a copy leaves
  behind, and offers to move them to the trash. An untrusted Motif is not
  listed, since its files travel; trust stays per machine
  ([ADR 0174](0174-a-motif-runs-only-when-trusted-on-this-machine.md)).
- **One definition of the content.** `PROJECT_CONTENT` with the Motif table's
  folders is what Save As copies and what a pack holds. Everything else is
  machine-local (`PROJECT_MACHINE_LOCAL`): `Cache/`, `Backups/`, `Logs/`,
  `output/` and `project.pre-v*.json`. The same list makes the `.gitignore` a
  new project, a Save As target or an unpacked folder gets when it has none.
  A user's own `.gitignore` is kept and copied as content.
- **A pack is one `.weftcut` file**, written and read in Rust
  (`commands/project_pack.rs`):
  - It is a ZIP. Every entry is stored, not recompressed, with ZIP64 for an
    entry of 4 GiB or more.
  - The first entry is a manifest listing every file with its size and exact
    modification time. The time goes back on unpack, so the project opens
    without hashing its media again. ZIP's own time has a 2 s resolution.
  - A ZIP, not a tar, because an open reads the manifest and `project.json`
    without walking the archive, and refuses a newer schema before writing
    anything. OS file managers can also look inside.
- **A pack waits for imports.** A file still being copied into `Media/` is
  recorded at its source outside the folder until the copy lands, so a pack
  started meanwhile waits for every import into the project, the open's
  recovery of unfinished ones included, to land or fail. Cancel ends the wait.
  A copy that failed leaves its file outside, as the portability check says.
- **An archive is checked before anything is written.** Every entry must be
  listed in the manifest at the size it gives. Every path must be a project
  path under a content entry; links and names one case-insensitive volume
  would merge are refused.
- **No partial result under a final name.** A pack is written beside its
  target and renamed. An unpack fills a dot-named sibling folder and renames
  it, into a new or empty folder only. A cancel or failure removes what the
  run wrote.
- **Opening a pack** goes through the start screen or the File menu. The
  user picks the parent folder, and the unpacked folder opens through the
  ordinary open path. The pack dialog embeds the portability check and
  carries one licence line for the fonts it holds.

## Consequences

- A pack is as large as the content it holds; the media is not recompressed.
- A pack made on one OS opens on another: project paths are portable
  (ADR 0175), and the Motifs it holds must be trusted on the new machine.
- Undo history and Motif revision backups (`Backups/`) do not travel; the
  unpacked project starts a new history.
- Double-clicking a `.weftcut` file does not open it yet. File association
  needs installer and `open-file` work on three OSes, and is a separate
  change.
