---
status: accepted
---

# A project collects the fonts it uses

Date: 2026-11-20

## Context

A project folder carries its media and Motifs ([ADR 0151](0151-a-file-the-pool-holds-is-imported-once.md),
[ADR 0173](0173-the-project-folder-holds-what-it-renders.md)), but not its
fonts. Copied to another machine, its text drew in whatever that machine had.
The 2026-11-17 portable-project spec left collection to the user's act, but a
folder copied to a drive passes no step where the app could ask. The font code
had its own gaps:

- Preview registered only the two bundled families and drew every other
  through Chromium's local lookup; the export Worker received one file per
  family, registered without weight or style. Bold and italic Text drew the
  real face in preview and a synthesised Regular in export.
- The system scan read only the `name` table's family (nameID 1), so a
  family's Regular and Bold collided on one key, "Inter SemiBold" was a family
  of its own, and a `.ttc` gave only its first face.
- An unresolved family was dropped without a word, then matched by the
  browser; the Worker had no system fallback at all.
- A style's font slot was frozen at layer creation to the families installed
  on that machine, so a project made where the first choice was missing kept
  the fallback forever.

## Decision

- **Fonts a project draws are copied into `Fonts/` automatically**, like
  `Media/` and `Motifs/`, when the project opens and whenever what it draws
  changes. This replaces the spec's rule that collection is the user's act.
- **Only faces that draw are collected.** A Text layer's characters are walked
  through its family list, and each face that draws at least one is a use. A
  Motif's text is the characters of its string props (the layer's values, else
  the manifest's defaults), walked the same way through each `font_<slot>`
  list at Regular upright; text written into a Motif's HTML is not seen. A
  bundled or CSS generic family ends a walk. A style slot no layer uses
  collects nothing. Bundled and generic families and the fonts a Motif package
  ships are never collected.
- **A face is family + weight + italic**, read from the font's own tables
  (typographic family, `OS/2`, `fvar`), never from the file name. A collection
  (`.ttc`) face is extracted to a single-face file. A different version of the
  same face already in `Fonts/` counts as present, and it wins.
- **One lookup, everywhere:** project `Fonts/`, then system, then bundled,
  through one resolver over one face index, so preview, export and Motif
  hosts draw the same face. Preview and export register faces under alias
  families (`wf-<sha16>`), so two files naming one family never shadow each
  other.
- **No licence gate.** The app reads no `fsType` and refuses no font: the
  user's own licence decides, and it may differ from a font's default
  embedding flags. The app tells, once per batch that first copies a family,
  with a warn log line naming the families and asking the user to check their
  licences before sharing the folder; Settings → Project → Fonts keeps the
  same reminder in amber, and the pack dialog carries one licence line. No
  bell row: the bell lists states that need the
  user ([ADR 0166](0166-the-status-bar-answers-three-questions.md)), and a copy
  needs nothing then.
- **The exclusion list is the only expression of intent.** `settings.excluded_fonts`
  names families the project never collects, compared without
  case; it is edited only in Settings → Project → Fonts and is not writable
  over MCP. Excluding moves the family's files to the OS trash; Allow copying
  removes the entry and copies at once.
- **Absence is never intent.** A collected face missing from `Fonts/`
  (deleted by hand, a partial copy, a sync that skipped it) is copied again
  where it is installed, with a log line pointing at the exclusion list;
  elsewhere it is a missing font.
- **A missing font is visible per layer**: a note under the layer's font in
  the properties panel, `fonts.missing` in `project://session` naming the
  layers, and one warn log line when a face is first found missing. A family
  is missing when no face answers to it and it comes before the first family
  in its list that draws (one rule for main and the renderer); families after
  that one are fallbacks. The next family in the list draws instead, else a
  bundled one.
- **Copies finish before the folder is let go.** Closing, quitting, opening
  another project and Save As wait for pending copies, shown in the work pill.
  Each copy is written as `.part` and renamed, so an interrupted one leaves no
  partial font; a stale `.part` is deleted at open. Save As copies `Fonts/`
  and `Styles/`.
- **Motif frame keys carry the resolved face hashes**, and only for Motifs
  with `font_*` props, so other keys are unchanged. Style slot props keep the
  whole family list and are resolved at render time (ADR 0126).
- **`Styles/<name>/`** holds the user style `TASTE.md` extends, copied into the
  project and looked up first. A project style never takes a built-in's name.

## Consequences

- The catalog records each system font file's digest and face identities
  against its file stamp, the rule of
  [ADR 0164](0164-a-motif-package-revision-is-remembered-by-its-file-stamps.md), in
  `<data>/cache/font-records.json`, so a launch reads and hashes only new or
  changed font files. Project `Fonts/` records stay in memory.
- A project folder renders the same text on a machine without its fonts
  installed; frames differ across machines only where a font is missing.
- Each project pays the disk cost of its fonts. A CJK family of a few
  weights adds tens of megabytes; covering only the faces that draw keeps
  that to what the film shows.
- A Motif collects only for text that comes from its props; an author who
  hard-codes text in the HTML gets no font of it in `Fonts/`.
- A Windows session end cannot wait: an unfinished copy is dropped and redone
  at the next open.
- Deleting a family's files from `Fonts/` does not keep it out; only the
  exclusion list does.

Rejected: a licence gate on `fsType` (it answers the font's default, not the
user's licence); collection on a user action (a folder copied by hand would
travel without fonts); every face of a used family, and whole `.ttc` files
(disk cost for faces nothing draws); reading a deleted file as an exclusion
(indistinguishable from a failed sync); an app-wide exclusion list; a bell row
per copy; a Motif's uses as the faces its capture host fetched
(`document.fonts.load` of a stack loads a face of every family in it, and a
Motif whose frames are cached fetches nothing, so a deleted face would never
be copied again).
