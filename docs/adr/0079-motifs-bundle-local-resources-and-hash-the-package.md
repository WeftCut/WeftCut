---
status: accepted
---

# Motifs bundle local resources and hash the package

## Context

Three.js scenes need local JS modules, model buffers and textures. The old render
CSP permitted only inline code and prohibited fetch, including data/blob fetches.
Merely permitting local files would leave asset edits invisible to the HTML-only
frame hash, and edit drafts would lose assets because they copied only HTML.

## Decision

- A Motif is a directory rooted at `index.html`, optionally with companion files.
  Package import accepts its manifest island or a separate `manifest.json`.
  Import copies a snapshot into a fresh draft; edit/fork and install preserve all
  companion files. Relative URLs survive app-assigned ids and publishing.
- Distribution uses a ZIP containing one complete Motif folder. The picker has
  one Import Motif action accepting only ZIP, plus Export Motif ZIP
  for the selected built-in, installed or draft. ZIP import also accepts files
  at the archive root and validates the package before creating a draft.
  Export omits private Update metadata; import always mints a fresh identity.
  Direct HTML and folder imports are removed from both the picker and backend;
  single-file Motifs also travel as ZIPs containing `index.html`. HTML source
  editing and MCP draft authoring remain available independently of import.
- ZIPs are bounded to 256 MiB compressed/expanded and 10,000 entries. Unsafe,
  duplicate, case-aliased and conflicting file/directory paths are rejected
  before any draft is written. Entries are copied as regular bytes; ZIP link
  attributes never create filesystem links.
- Render CSP permits script/style/font/image/fetch from the page's own
  `motif://<id>` origin. Data/blob fetches and Blob images support common model
  loaders. No HTTP(S), other Motif origins, `file:`, editor schemes, workers or
  eval are granted. The opaque-origin parameter page keeps its separate CSP.
- Companion names and bytes join the canonical manifest and HTML in the frame
  content hash. `index.html` is already hashed; private root `target` metadata is
  excluded and unservable. All other files count, including parameter resources,
  because scripts can read any file in their package. Responses use no-store.
- Import and serving refuse path traversal and symbolic links/junctions. A
  published package never borrows missing resources from a same-id draft.

## Consequences

This revises ADR 0045's exclusion of parameter-page contents from the render
hash. The `has_params_ui` flag still remains payload-only and outside the
manifest. An edit to a parameter-only resource may conservatively invalidate
frames; tracking JS's dynamic dependencies would be more complex and less safe.
ADR 0017's offline capture and deterministic time contract remain in force.

The source panel still edits HTML. Companion files use an external editor in the
stored package directory. MCP HTML drafts with `from` inherit companion files;
new binary packages enter through ZIP import. npm resolution and remote CDNs
are not supplied by the host. Draco/KTX2 worker/WASM decoders are not enabled by
this change.

Validation covers a real Three.js module scene, local GLB with an embedded Blob
texture, external PNG, repeated/backward capture, asset-only invalidation, and
blocked network/cross-Motif/file/editor-scheme fetches in Electron.
