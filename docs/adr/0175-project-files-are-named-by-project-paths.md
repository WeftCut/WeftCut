---
status: accepted
---

# Project files are named by project paths

Date: 2026-11-18

## Context

A project folder copied to another machine should open with every file found
([ADR 0152](0152-the-project-folder-is-an-agents-working-directory.md),
[ADR 0173](0173-the-project-folder-holds-what-it-renders.md)). Up to schema v6
it did not, for causes in this repo:

- `path_rel` carried the authoring OS's separator. Rust built it with
  `PathBuf::from("Media").join(name)` and TS with `path.join`, so a project
  written on Windows recorded `Media\x.mp4`; on macOS or Linux the open joined
  that as a file literally named `Media\x.mp4`, missed, and healed every item
  by hashing same-size files.
- `project.json` stored `path_abs` and the absolute cache paths of every
  derivative (`conform_path`, `waveform_path`, `thumbnails_dir`, the route's
  proxy slots). They named the authoring machine's home folder in a shared
  file and were wrong the moment the folder moved. Two compensations grew
  around them: a full proxy was adopted under its legacy name only when the
  stored path matched it, and the open cleared proxies whose stored recipe
  version was old.
- Import kept a name only one OS might accept (`a:b.mp4`, `CON.mp4`, two names
  equal but for case), relink looked only at the top of `Media/`, a TTS
  voiceover lived in `Cache/voiceover/` with an absolute path and a request key
  for a hash, and Save As wrote only `project.json`, so the copy opened with
  every item missing.

## Decision

- **One value type for a path inside a project folder**, the same rules in
  both languages: `ProjectPath` (`src/shared/projectPath.ts`) and
  `ProjectRelPath` (`native/src/state/project_path.rs`), tested against one
  vector file (`fixtures/project-paths.json`). A project path is relative and
  `/`-separated; no segment is empty, `.` or `..`; every segment is NFC, at
  most 255 UTF-8 bytes, free of `<>:"|?*\` and control characters, ends in
  neither a dot nor a space and is not a Windows device name. Constructing one
  validates it; the Rust type has no `AsRef<Path>`, so it cannot be joined by
  accident.
- **One conversion to an OS path.** `toNative(projectDir, p)`
  (`src/main/state/projectPathNative.ts`) and `ProjectRelPath::to_native` are
  the only places a project path meets a path library; `fromNative` is the only
  way back and refuses rather than rewrites. A conformance test fails on any
  other `join` of a `path_rel`.
- **`project.json` holds no absolute path for a file inside the folder.** The
  disk form (`projectFile.ts`) keeps `path_rel`, keeps `path_abs` only for
  external media (`path_rel` null), drops the derivative paths and writes the
  decode route as its tag alone. `serializeProject` stays the runtime wire to
  Rust, which reads absolute paths. On open, `path_abs` is `toNative` of the
  folder the project was opened from.
- **Derivatives are found by content on open.** Before the first publish the
  open asks Rust which derivatives the cache already holds for each item's hash
  and current recipe (`hydrate_derivatives`, reading the cache only), so a moved
  or copied project shows its proxies, waveforms and thumbnails without a job.
  The legacy-name adoption and the stale-version clear are removed.
- **Import names are portable.** Rust picks every import and voiceover name
  with `portable_file_name`: reserved characters become `_`, a device name
  gains `_`, the name fits 255 bytes, and a name taken in any letter case gets
  `-2`, `-3`.
- **Relink walks all of `Media/`** and heals a file back to its recorded path,
  subfolder included.
- **A voiceover is media.** TTS keeps `Cache/voiceover/` as its request cache
  and pools a copy at `Media/Voiceover/voiceover-<hash8>.mp3` with the hash of
  its bytes, so it travels with the folder and dedupes like any import ([ADR 0151](0151-a-file-the-pool-holds-is-imported-once.md)).
- **Save As copies the project's content**: `Media/`, `TASTE.md`,
  `export.json`, `view.json`, beside the existing Motif copy; never `Cache/`,
  `Backups/` or logs. Each file is cloned where the filesystem can (APFS,
  btrfs, XFS), else, for a media file, hard-linked on the same volume (`TASTE.md` and the other files people edit are never linked), else copied, and keeps its
  modification time so the copy opens without re-hashing.
- **Schema v7, one conversion.** The v6 → v7 step rewrites each stored
  `path_rel` once: `\` to `/`, NFC, names other OSes refuse cleaned, names that
  collide case-folded suffixed, and a path that leaves the folder (absolute or
  `..`) turned into external media. It drops what the runtime derives and plans
  the file moves the open performs: a full proxy under its legacy name is
  renamed to its recipe name, and a voiceover is copied into
  `Media/Voiceover/` and hashed on open. The step never refuses a project; the
  pre-upgrade bytes stay in `project.pre-v6.json`. There is no reader for the
  old form: a v7 file whose `path_rel` is not a project path refuses the open,
  naming the media item.

## Consequences

- A project written on any OS opens on any other with every item found by
  path, without hashing.
- A file renamed by the step is still under its old name on disk; the open finds
  it by content and renames it, as for any renamed file.
- Save As no longer shares the source folder's cache, so the copy rebuilds its
  full proxies. A hard-linked media file shares bytes with the source folder until
  either is rewritten; an in-place edit of one shows as a changed source in the
  other ([ADR 0153](0153-reuse-is-decided-in-one-place-from-current-facts.md)).
- Motif package file names follow the same segment rule, so a package whose
  file names are not NFC (as an old HFS+ volume would list them) is refused.
- MAX_PATH on Windows bounds the whole absolute path, which a project path
  cannot know; a deep folder can still exceed it.
