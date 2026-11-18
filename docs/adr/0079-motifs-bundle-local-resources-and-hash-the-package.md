---
status: accepted
---

# Motifs bundle local resources and hash the package

Date: 2026-09-29

## Context

Three.js scenes need local JS modules, model buffers and textures. The render
CSP allowed only inline code and no fetch. Merely allowing local files would
leave asset edits invisible to an HTML-only frame hash (stale cached frames),
and edits/forks that copied only HTML would lose assets.

## Decision

- **The package is the unit.** A Motif is a directory rooted at `index.html`
  with optional companion files; its manifest is `manifest.json` when present,
  else the island. Edit/fork, publish and export carry the whole directory;
  relative URLs survive app-assigned ids. A published package never borrows a
  missing resource from a same-id draft.
- **ZIP is the distribution format.** One Motif folder (or its contents at the
  root), ≤ 256 MiB compressed/expanded and ≤ 10,000 entries. Unsafe, duplicate,
  case-aliased and file/directory-conflicting paths are rejected before any
  draft is written; link attributes never create links. Import always mints a
  fresh identity; export omits private `target` metadata.
- **Render CSP grants the page's own origin only:** script/style/font/image/
  fetch from `motif://<id>`, plus data/blob fetches and Blob images for model
  loaders. No HTTP(S), other Motif origins, `file:` or editor schemes.
  Responses are `no-store`.
- **Every companion file's name and bytes enter the frame content hash**,
  including `params.html` and its assets, because a render script can read any
  file in its package. Only root `target` is excluded (and unservable).
- Serving and import refuse path traversal and symbolic links/junctions.

## Consequences

- An edit to a parameter-only resource conservatively invalidates frames;
  tracking a script's dynamic dependencies would be more complex and less safe.
- `has_params_ui` stays payload-only, outside manifest and hash (ADR 0045).
- npm resolution and CDNs are never supplied by the host; packages bring their
  own modules or import maps.
- Worker/WASM decoders are a separate grant ([motifs.md § Security](../motifs.md#security)).

## Note (2026-11-17): no private package path; a ZIP names its lineage

[ADR 0171](0171-a-motif-lineage-is-apart-from-its-id.md) removed the private
`target` file: every file a package holds is hashed and served, and only
`.revisions` stays reserved. Import still mints a new id, but a ZIP the app
exports names its Motif's lineage in a `weftcut-lineage.json` entry beside the
folder, and the imported draft keeps it.

## Note (2026-11-17): a ZIP becomes a project Motif

Importing a ZIP makes a Motif in the open project
([ADR 0173](0173-the-project-folder-holds-what-it-renders.md)). It keeps the id
its manifest carries, or one made from its name when that id is not valid; an
id the project holds becomes `<id>-<first 8 hex of its lineage>`. It keeps the
lineage the archive names unless the project already holds that lineage.
