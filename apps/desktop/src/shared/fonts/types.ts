// The font face catalog's value types, shared by main (which builds the
// catalog, src/main/fonts/catalog.ts) and the renderer (which resolves Text
// layers against the index and registers faces). Matching rules live in
// ./resolve.ts.

/** A face's weight: one value, or the `[min, max]` of a variable font's
 *  `wght` axis. On the CSS scale, 1–1000. */
export type FaceWeight = number | readonly [number, number]

/** Where a face was found. Bundled fonts (src/shared/fonts.ts) are never in
 *  the catalog: callers handle them. */
export type FaceSource = 'project' | 'system'

/** One face of one font file; each face of a `.ttc` collection is its own
 *  record. */
export interface FaceRecord {
  /** Every family name the face answers to: the typographic family (nameID 16)
   *  first when the font has one, then the legacy family (nameID 1), each in
   *  every language the font carries, en-US first. Deduplicated
   *  case-insensitively, keeping the casing of the first spelling. Never empty. */
  families: string[]
  weight: FaceWeight
  /** True for italic and oblique faces alike. */
  italic: boolean
  source: FaceSource
  /** The face's key. For a single-face file, the SHA-256 of the file. For a
   *  face of a collection, the SHA-256 of `<file digest hex>#<face index>`:
   *  unique per face without hashing every extracted face during a scan. */
  sha256: string
  /** Size of the file on disk in bytes (the whole collection for a TTC face). */
  size: number
  /** Absolute path. Main only: never crosses to the renderer. */
  file: string
  /** Face index inside a `.ttc`/`.otc` collection; null for a single-face file. */
  ttcIndex: number | null
}

/** A face as the renderer sees it: no path. */
export type FaceIndexEntry = Omit<FaceRecord, 'file'>

/** The catalog at one moment. `revision` grows whenever the face set or
 *  `complete` changes, so a holder of an older copy knows to refetch. */
export interface FontIndex {
  revision: number
  /** False until the system scan has landed and the open project's `Fonts/`
   *  has been read once: a family missing now may only not be indexed yet,
   *  and a face resolved now may not be the one the project carries. */
  complete: boolean
  faces: FaceIndexEntry[]
}

/** What a renderer needs to fetch a face's bytes (by `sha256`) and register
 *  it as a FontFace: the family is `faceAlias(sha256)` (./resolve.ts), the
 *  descriptors are `weight` and `italic`. */
export interface FaceRef {
  sha256: string
  weight: FaceWeight
  italic: boolean
}

/** Settings > Project > Fonts: what `Fonts/` holds, by family, and the
 *  exclusion list. */
export interface ProjectFontsView {
  /** Absolute path of the project's `Fonts/`, for Show in folder: the
   *  renderer holds no project path of its own. */
  dir: string
  /** Families with at least one face in `Fonts/`, sorted by name. */
  copied: { family: string; files: number; bytes: number }[]
  /** `settings.excluded_fonts`, in list order. `installed` is whether this
   *  machine has the family, so Allow copying can copy it now; the panel
   *  shows only installed ones. */
  excluded: { family: string; installed: boolean }[]
}

/** Copies into `Fonts/` in flight. `closing` is set while a close, quit or
 *  project switch waits for them. */
export interface FontCopyProgress {
  done: number
  total: number
  closing: boolean
}
