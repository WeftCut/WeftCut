// apps/desktop/src/shared/motifs/fontProps.ts
//
// A Motif's font props (`font_<slot>`, docs/motif-authoring.md § Style
// Motifs): CSS family lists whose faces the app serves to the capture host
// page from the font catalog, project `Fonts/` first (ADR 0176). One rule for
// the renderer, which keys frames by these faces and sends them with its
// captures, and for main, which resolves captures nobody keyed (MCP previews,
// covers). Families the package ships (`manifest.fonts`) and bundled
// families are drawn by the page or app themselves and never served.

import { familyFaces, parseFamilyList } from '../fonts/resolve'
import type { FaceIndexEntry } from '../fonts/types'
import type { Manifest, PropSpec } from './catalog'
import type { MotifFontFace } from './frameTransport'

/** The directory on a Motif's origin its served faces live under:
 *  `motif://<id>/.fonts/<sha256>.<ext>`. */
export const MOTIF_FONTS_DIR = '.fonts'

export function isMotifFontProp(key: string, spec: PropSpec): boolean {
  return key.startsWith('font_') && spec.type === 'string'
}

/** A Motif layer's font slots: each font prop's family list, the layer's own
 *  value when it is a string, else the manifest's default. */
export function motifFontSlots(manifest: Pick<Manifest, 'props_schema'>, props: Readonly<Record<string, unknown>>): { key: string; css: string }[] {
  const out: { key: string; css: string }[] = []
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    if (!isMotifFontProp(key, spec)) continue
    const value = props[key]
    const css = typeof value === 'string' ? value : spec.default
    if (typeof css === 'string') out.push({ key, css })
  }
  return out
}

export interface MotifFonts {
  /** Font prop → the sha256 of every face its list's leaves answer to, in
   *  list order: the frame key's `fontKeys`. */
  keys: Record<string, string[]>
  /** The faces to register in the page, once per (family, face). */
  faces: MotifFontFace[]
}

type Input = Pick<Manifest, 'props_schema' | 'fonts'>

const isWeight = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

/** Whether `value` is a face list as `motifFonts` makes it, checked where
 *  one crosses from a renderer (a capture request, a bake plan). Shape only:
 *  main serves no face its own catalog lacks. */
export function isMotifFontFaces(value: unknown): value is MotifFontFace[] {
  return Array.isArray(value) && value.every((f) => {
    const face = (f ?? {}) as Record<string, unknown>
    return typeof face.family === 'string' && face.family.length <= 200
      && typeof face.sha256 === 'string' && /^[0-9a-f]{64}$/.test(face.sha256)
      && typeof face.italic === 'boolean'
      && (isWeight(face.weight) || (Array.isArray(face.weight) && face.weight.length === 2 && face.weight.every(isWeight)))
  })
}

const memo = new WeakMap<readonly FaceIndexEntry[], Map<string, MotifFonts>>()
const MEMO_CAP = 256

/** The faces a Motif's font props resolve to in `faces` (a font index), or
 *  null for a Motif without font props. Every face of every leaf is
 *  included, not one per leaf: which weight and style the page draws is its
 *  CSS's choice, and Chromium loads only the faces the page draws with. The
 *  result is shared between callers: never mutate it. */
export function motifFonts(manifest: Input, props: Record<string, unknown>, faces: readonly FaceIndexEntry[]): MotifFonts | null {
  const keys = Object.entries(manifest.props_schema).filter(([key, spec]) => isMotifFontProp(key, spec)).map(([key]) => key)
  if (!keys.length) return null
  const shipped = (manifest.fonts ?? []).map((f) => f.family.trim().toLowerCase())
  // Resolved per frame by the renderer: an index of thousands of system faces
  // makes the walk worth keeping per index copy.
  const memoKey = JSON.stringify([shipped, keys.map((k) => [k, props[k]])])
  let byIndex = memo.get(faces)
  const hit = byIndex?.get(memoKey)
  if (hit !== undefined) return hit
  const out: MotifFonts = { keys: {}, faces: [] }
  const registered = new Set<string>()
  for (const key of keys) {
    const value = props[key]
    const shas: string[] = []
    for (const family of typeof value === 'string' ? parseFamilyList(value) : []) {
      if (shipped.includes(family.toLowerCase())) continue
      for (const face of familyFaces(faces, family)) {
        if (!shas.includes(face.sha256)) shas.push(face.sha256)
        const id = `${family}\0${face.sha256}`
        if (registered.has(id)) continue
        registered.add(id)
        out.faces.push({ family, sha256: face.sha256, weight: face.weight, italic: face.italic })
      }
    }
    out.keys[key] = shas
  }
  if (!byIndex) memo.set(faces, byIndex = new Map())
  if (byIndex.size >= MEMO_CAP) byIndex.clear()
  byIndex.set(memoKey, out)
  return out
}
