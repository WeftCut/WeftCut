---
status: accepted
---
# Text font preferences share the system font catalog

## Context

[PR #41 by baraa (@baraa404)](https://github.com/WeftCut/WeftCut/pull/41)
proposed importing fonts and choosing a default text font. Its default-font
preference and settings-store approach are retained. The review chose OS font
installation instead of maintaining an app-owned font store. The inspector's
fixed list hid the system fonts that preview and export already supported.

## Decision

`default_text_font` is an optional app preference. Empty clears it to the bundled
`Liberation Sans, Noto Sans SC` chain. The main-process actor supplies the current
preference to `prodTextParams` for UI insertion, the Text tool, MCP creation and
dry-run. Changing the preference affects future authored Text layers only;
existing layers, pasted layers, imported captions and demo fixtures keep their
fonts. Undo/redo restores the font recorded when the layer was created.

This qualifies ADR 0049's bundled default: its factory remains the fallback,
and an explicit app preference overrides only the new layer's family. As in
ADR 0026, user-selected fonts carry no cross-machine determinism guarantee.

`resolveSystemFont.ts` owns a lazy process-lifetime catalog. Listing families
and resolving export bytes await the same promise, including while the first
scan is in flight. Directory and file reads are asynchronous; family lookup
is case-insensitive while labels retain their original spelling. Missing or
unreadable font files are skipped. The existing best-effort sfnt parser remains
in use: TTF/OTF and the first face of TTC collections in standard platform font
directories, rather than a new independent enumeration/parsing backend.

The sandboxed, context-isolated renderer receives family names through a narrow
`font.listFamilies()` preload method. Main admits font IPC only from the editor's
main frame, validates resolution arguments and never accepts font paths from
the renderer. The picker does not fetch or register font bytes; the existing
`render/fonts/registry.ts` remains their authority.

Settings and the inspector share `FontSelect` and one renderer promise cache.
Mounting several pickers, switching panels or remounting cannot duplicate IPC
or filesystem scans. The picker retains bundled choices and the current value
during loading/failure, including missing fonts and fallback chains from other
machines. Failed IPC can retry. Install fonts through the OS and restart the
app to refresh the catalog; there is no second refresh/invalidation lifecycle.

## Attribution

Credit the original default-font contribution in the implementation commit:

```text
Inspired by the default text font preference in WeftCut/WeftCut#41.

Co-authored-by: baraa <baraa0email@gmail.com>
```

The name and email are taken from the author's commits in PR #41. This credit
preserves the contribution while the final implementation follows the agreed
system-font scope.
