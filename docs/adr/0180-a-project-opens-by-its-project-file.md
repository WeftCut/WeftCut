---
status: accepted
---

# A project opens by its project file

Date: 2026-11-25

## Context

A project is a folder: an agent works in it (ADR 0152) and it holds what it
renders (ADR 0173). Its state was `project.json`, and Open picked the folder.
A pack (ADR 0178) is a file, so the start screen grew a second Open button.

- On Windows and Linux one Electron dialog cannot pick either a folder or a
  file; asked for both, it shows a folder picker. One Open over projects and
  packs needs both to be files.
- `.json` says nothing about the app that owns the file, and no installer can
  associate it with one. Double-click opening needs an extension of our own.
- Folder-based editors elsewhere (DAWs, game engines) open their folder by a
  marker file inside it.

## Decision

- **The project file is `project.wcpr`**: the same JSON, under a fixed name.
  Fixed, so renaming the folder never leaves a stale file name, and an agent
  finds it without a lookup. **A pack is a `.wcpk`.** Neither extension had a
  registered user when chosen.
- **Every open takes the folder or the `project.wcpr` in it**: the start
  screen, the File menu, Recent, launch and MCP `open_project`. A file path is
  resolved to its folder before anything compares or records it, so the two
  are the same project.
- **Open project is one file picker** on the start screen and in the File
  menu. A `.wcpr` opens in place; a `.wcpk` is read, then the user places the
  new folder (ADR 0178). A second filter takes a 0.8 `project.json`, so a
  project missing from Recent can still be picked. From the editor the open
  replaces the project as an agent's open does.
- **A 0.8 folder is renamed on open.** The open reads `project.json` and,
  once the project validates and its pre-upgrade bytes are kept, renames it
  to `project.wcpr`. A failed rename refuses the open with nothing swapped.
  With both files there, `project.wcpr` is read and `project.json` left alone.
  Pre-upgrade backups stay `.json`, so a backup is never what an open picks.
- MCP `open_project` refuses a `.wcpk`: an unpack makes a new folder, and
  where it goes is the user's call.

## Consequences

- Once this version opens a project, WeftCut 0.8 no longer finds it, even
  without an edit. The schema upgrade already refused 0.8 after the first
  save; `project.pre-v{n}.json` remains the way back.
- File association and double-click opening are a separate change (installers
  and `open-file` on three OSes); they now have one file type per thing to
  register.
- The folder is still the project: Recent stores folders, and the file is
  only its handle.
