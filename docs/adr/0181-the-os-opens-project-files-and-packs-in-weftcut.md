---
status: accepted
---

# The OS opens project files and packs in WeftCut

Date: 2026-11-25

## Context

A project file is `project.wcpr` and a pack a `.wcpk` (ADR 0180), so each OS
can be told WeftCut opens them. What registers them, and how the file reaches
the app, differs per package:

- **Windows (NSIS) and the deb** have an install step that writes the
  registration and its uninstall that removes it. Every update reruns the
  installer, so an existing install registers on its next update.
- **macOS** reads the types from the bundle's Info.plist once LaunchServices
  sees the app. Without an exported UTI, the bundle claims a bare extension
  and other apps can outrank it.
- **The AppImage** is one file the user runs; nothing installs it.
- The file arrives three ways: on the command line of a cold start (Windows,
  Linux), through a second launch that the single-instance lock (ADR 0163)
  quits, and as macOS `open-file`, which reaches the running app and, on a
  cold start, arrives before `ready`.
- The renderer used to decide whether a picked file was the open project by
  comparing strings. A path from the shell can spell the same folder
  differently (case, symlinks, `file://`), and a miss reloads the project and
  drops its undo history.

## Decision

- **One table of owned types** (`fileTypes.ts`): extension, ProgID, MIME type,
  UTI, description. electron-builder.yml carries copies, which a test holds to
  it: `fileAssociations` for NSIS and the deb, and Info.plist document types
  with exported UTIs owned at rank `Owner` for macOS. The OS draws the
  document icon from the app's.
- **An AppImage registers itself** at every packaged start: a MIME package and
  a hidden desktop entry (`weftcut-appimage.desktop`, `Exec="$APPIMAGE" %U`)
  under the XDG data home, rewritten only when they differ. Its name differs
  from the deb's entry, so it never replaces the deb's launcher.
- **Main keeps one request until the window takes it.** `entry.ts` feeds it
  from the launch's command line, from a second launch's
  `requestSingleInstanceLock` data (its own target, resolved where it was
  launched) and from `open-file`, all before its first await. Only an
  absolute path with an owned extension is accepted. The window can only ask
  whether one waits and take it.
- **A file-open request opens as the same file picked in Open project.** At
  launch it comes before reopening the last project, and the start screen
  takes it. The start screen takes one once it is idle. The editor refuses one
  at once with a notice while Open is unavailable, rather than replacing the
  project when a long task ends.
- **Main decides whether the file is the project already open**, on the
  resolved real folder. The user's Open and an agent's ask with
  `keep_if_open` and leave that project as it is; a bare `project_open`
  stays a reload from disk.

## Consequences

- Deleting or moving an AppImage leaves its handler behind until another
  AppImage start rewrites it; there is no uninstall to remove it.
- A pack from the desktop still asks where its new folder goes (ADR 0178).
- Two requests before the window takes one: the later wins.
