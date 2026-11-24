// apps/desktop/src/shared/portability.ts
//
// The portability check's report: what the open project still needs from
// outside its folder. Main builds it (src/main/state/portability.ts); the
// renderer's check dialog and the MCP view `project://portability` show it.

export interface PortabilityMedia { media_id: string; label: string; path: string }

export interface PortabilityReport {
  /** True when nothing below makes the folder depend on this machine;
   *  `motifs.untracked` does not count, since nothing renders from it. */
  portable: boolean
  media: {
    /** Files the project uses from outside its folder. */
    outside: PortabilityMedia[]
    /** Files the project uses that are not on this machine either. */
    missing: PortabilityMedia[]
  }
  motifs: {
    /** Motifs the project places whose `Motifs/<id>/` folder is gone. */
    missing: { motif_id: string; diagnostic: string }[]
    /** Motifs whose folder holds no package. */
    invalid: { motif_id: string; diagnostic: string }[]
    /** Folders under `Motifs/` the project does not place (an undone place, a
     *  deleted Motif): Save As and a pack leave them behind. */
    untracked: string[]
  }
  fonts: {
    /** Families the user excluded from `Fonts/` (Settings > Project > Fonts):
     *  the project draws them from this machine's installed fonts. */
    excluded: { family: string; installed: boolean }[]
    /** Families the project asks for that resolve nowhere, here included
     *  (main's `MissingFontUse`). */
    missing: { family: string; weight: number | null; italic: boolean | null; layer_ids: string[] }[]
  }
  /** The user style TASTE.md extends when the folder does not hold it. */
  style: { outside: string | null }
}
