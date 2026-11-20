// apps/desktop/src/main/motif/fontProps.ts
//
// Font props at capture time (ADR 0176), the twin of ./mediaProps.ts. Before
// `setup`, the faces a Motif's `font_<slot>` props resolve to
// (shared/motifs/fontProps.ts) go to the page as `meta.fonts`: one entry per
// face, under the family name the prop gives it, with a URL on the Motif's own
// origin, `motif://<id>/.fonts/<sha256>.<ext>`, which the motif protocol
// serves from here. The render CSP's `font-src 'self'` covers it. Which of
// these faces a project collects is not decided here: see main/fonts/uses.ts.

import fs from 'node:fs'
import path from 'node:path'
import { isBundledFamily } from '../../shared/fonts/resolve.js'
import type { FaceIndexEntry, FaceWeight, FontIndex } from '../../shared/fonts/types.js'
import type { Manifest } from '../../shared/motifs/catalog.js'
import { MotifError } from '../../shared/motifs/errors.js'
import { MOTIF_FONTS_DIR, motifFonts } from '../../shared/motifs/fontProps.js'
import type { MotifFontFace } from '../../shared/motifs/frameTransport.js'
import type { FontCatalog } from '../fonts/catalog.js'

export interface MotifFontSource {
  catalog: Pick<FontCatalog, 'index' | 'faceFile' | 'faceBytes'>
}

let source: MotifFontSource | null = null

/** Wire the font catalog. Until then no Motif gets a served face, and its
 *  font props draw what Chromium finds on the machine. */
export function setMotifFontSource(next: MotifFontSource | null): void {
  source = next
}

/** A face as the capture host page registers it: FontFace descriptors in
 *  CSS syntax. */
export interface MotifPageFont {
  family: string
  /** `"700"`, or `"100 900"` for a variable face. */
  weight: string
  style: 'normal' | 'italic'
  url: string
}

/** Motif id → the faces a resolve handed its pages. Only these are served
 *  on its origin: the route is no window onto every font of the machine. */
const served = new Map<string, Set<string>>()

const FONT_PATH = new RegExp(`^${MOTIF_FONTS_DIR.replace('.', '\\.')}/([0-9a-f]{64})\\.(ttf|otf)$`)
const MIME = { ttf: 'font/ttf', otf: 'font/otf' } as const

const cssWeight = (w: FaceWeight): string => (typeof w === 'number' ? String(w) : `${w[0]} ${w[1]}`)
/** The served face's extension: CFF outlines come from `.otf`/`.otc` files. */
const extOf = (file: string): 'ttf' | 'otf' => (/\.ot[fc]$/i.test(path.extname(file)) ? 'otf' : 'ttf')

const facesBySha = new WeakMap<FontIndex, Map<string, FaceIndexEntry>>()

function indexed(index: FontIndex, sha256: string): FaceIndexEntry | undefined {
  let bySha = facesBySha.get(index)
  if (!bySha) facesBySha.set(index, bySha = new Map(index.faces.map((f) => [f.sha256, f])))
  return bySha.get(sha256)
}

/** Whether the face's file still holds what the catalog indexed, by its size:
 *  a stat per file, where hashing the bytes again would read every face on
 *  every capture. The font route checks the hash when it serves. */
async function servable(file: string, face: FaceIndexEntry | undefined): Promise<boolean> {
  if (!face) return false
  try {
    return (await fs.promises.stat(file)).size === face.size
  } catch {
    return false
  }
}

/** The faces `meta.fonts` hands the page for this capture. A face of a
 *  bundled family or of one the package ships is left out either way.
 *
 *  `keyed`: the faces the renderer made the frame's key with. Each must be
 *  served as keyed, or the frame stored under that key would draw another
 *  face: one the catalog lacks or whose file is gone refuses the capture as
 *  `transient`, which the renderer retries once its index catches up.
 *  Without `keyed` (MCP previews, covers), the props are resolved here and a
 *  face that cannot be served is left out. */
export async function motifPageFonts(motifId: string, manifest: Pick<Manifest, 'props_schema' | 'fonts'>, props: Record<string, unknown>, keyed?: readonly MotifFontFace[]): Promise<MotifPageFont[]> {
  const from = source
  if (!from) return []
  const index = from.catalog.index()
  const faces = keyed ?? motifFonts(manifest, props, index.faces)?.faces ?? []
  const shipped = new Set((manifest.fonts ?? []).map((f) => f.family.trim().toLowerCase()))
  const out: MotifPageFont[] = []
  // A face listed under two families is checked once.
  const checked = new Map<string, boolean>()
  for (const face of faces) {
    if (isBundledFamily(face.family) || shipped.has(face.family.trim().toLowerCase())) continue
    const file = from.catalog.faceFile(face.sha256)
    if (keyed) {
      let ok = checked.get(face.sha256)
      if (ok === undefined) checked.set(face.sha256, ok = !!file && await servable(file.file, indexed(index, face.sha256)))
      if (!ok) throw new MotifError('transient', `motif '${motifId}' was keyed with font face ${face.sha256.slice(0, 16)} (${face.family}), which this app cannot serve now`)
    }
    if (!file) continue
    let shas = served.get(motifId)
    if (!shas) served.set(motifId, shas = new Set())
    shas.add(face.sha256)
    out.push({
      family: face.family,
      weight: cssWeight(face.weight),
      style: face.italic ? 'italic' : 'normal',
      url: `motif://${motifId}/${MOTIF_FONTS_DIR}/${face.sha256}.${extOf(file.file)}`,
    })
  }
  return out
}

/** Whether `rest` (the path after the host, decoded) is on the font route:
 *  the protocol answers it here and nowhere else. */
export function isMotifFontPath(rest: string): boolean {
  return rest.startsWith(`${MOTIF_FONTS_DIR}/`)
}

/** The face at `motif://<motifId>/.fonts/<sha256>.<ext>`, a collection face
 *  extracted, or null (a 404) when no resolve handed that face to this
 *  Motif or its file is gone. */
export async function servedMotifFont(motifId: string, rest: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const m = FONT_PATH.exec(rest)
  const sha = m?.[1]
  const from = source
  if (!m || !sha || !from || !served.get(motifId)?.has(sha)) return null
  const bytes = await from.catalog.faceBytes(sha)
  if (!bytes) return null
  return { bytes, mime: MIME[m[2] as keyof typeof MIME] }
}
