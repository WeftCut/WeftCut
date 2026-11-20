// The project's font uses: which catalog faces it draws with, so the project
// font store (./projectFonts.ts) copies them into `Fonts/`, and which families
// it asks for that resolve nowhere, so `project://session` and the log can name
// the layers they affect. Only faces that draw are uses (ADR 0176). Matching a
// family to a face is ../../shared/fonts/resolve.ts and the missing rule is
// ../../shared/fonts/missing.ts; the walk here decides which of the matched
// faces a layer's characters actually reach.

import { missingLeaves } from '../../shared/fonts/missing'
import { familyFaces, isBundledFamily, isGenericFamily, parseFamilyList, requestItalic, requestWeight, resolveFace } from '../../shared/fonts/resolve'
import type { FaceIndexEntry, FaceWeight } from '../../shared/fonts/types'
import type { Manifest } from '../../shared/motifs/catalog'
import { motifFontSlots } from '../../shared/motifs/fontProps'
import { eachLayer, type MotifParams, type Project, type TextParams } from '../state/model'
import { fontFamilyKey } from '../state/excludedFonts'
import { hasGlyph, type Coverage } from './sfnt'

/** A family a layer asks for that no `Fonts/` face, system face or bundled
 *  font answers to. A Text layer's use carries its weight and italic; a
 *  Motif's is null for both: its own CSS picks the face. */
export interface MissingFontUse {
  family: string
  weight: number | null
  italic: boolean | null
  layer_ids: string[]
}

export interface FontUses {
  /** SHA-256 keys of system faces the project draws with and `Fonts/` lacks:
   *  what to copy. Sorted. */
  collect: string[]
  /** Sorted by family, then weight. */
  missing: MissingFontUse[]
}

/** The manifest fields the walk reads; null for a Motif that cannot be read. */
export type MotifFontManifest = (motifId: string) => Pick<Manifest, 'props_schema' | 'fonts'> | null

export interface FontUsesInput {
  project: Pick<Project, 'compositions' | 'settings'>
  /** The catalog index's faces (`FontCatalog.index().faces`). */
  faces: readonly FaceIndexEntry[]
  /** The code points a face draws (`FontCatalog.faceCoverage`, cached per face
   *  by the catalog); null when its file cannot be read. */
  coverage: (sha256: string) => Promise<Coverage | null>
  motifManifest: MotifFontManifest
}

/** One distinct walk: a family list at one weight and italic, the characters
 *  every layer asking it draws, and those layers. */
interface Request {
  css: string
  weight: number
  italic: boolean
  /** Family keys the Motif's package ships: they draw in the page, so they
   *  stop the walk like bundled ones and are never missing. Empty for Text. */
  shipped: ReadonlySet<string>
  codePoints: Set<number>
  layerIds: string[]
}

/** Characters no font is asked to draw: whitespace, control and format
 *  characters, and variation selectors (they pick a glyph, the base character
 *  draws it). */
const NOT_DRAWN = /[\s\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u

/** The code points `texts` draw, each once, sorted. */
function drawnOf(texts: readonly string[]): readonly number[] {
  const seen = new Set<number>()
  for (const text of texts) for (const ch of text) if (!NOT_DRAWN.test(ch)) seen.add(ch.codePointAt(0) as number)
  return [...seen].sort((a, b) => a - b)
}

/** The code points a Text layer draws, kept per params object: a publish
 *  walks every layer, and an unchanged layer keeps its params object across
 *  publishes. */
const drawnCache = new WeakMap<TextParams, readonly number[]>()

function drawnCodePoints(p: TextParams): readonly number[] {
  let out = drawnCache.get(p)
  if (!out) drawnCache.set(p, out = drawnOf([p.content]))
  return out
}

/** The text a Motif draws, as far as the app can see: its `string` props other
 *  than font props, the layer's value when it is a string, else the
 *  manifest's default. Text a Motif writes into its own HTML is not seen
 *  (docs/motif-authoring.md § Style Motifs). Without a readable manifest, the
 *  layer's own string props. */
function motifTexts(params: MotifParams, manifest: Pick<Manifest, 'props_schema'> | null): string[] {
  const out: string[] = []
  if (manifest) {
    for (const [key, spec] of Object.entries(manifest.props_schema)) {
      if (spec.type !== 'string' || key.startsWith('font_')) continue
      const value = params.props[key]
      out.push(typeof value === 'string' ? value : spec.default)
    }
  } else {
    for (const [key, value] of Object.entries(params.props)) if (!key.startsWith('font_') && typeof value === 'string') out.push(value)
  }
  return out
}

/** A Motif layer's font slots' family lists; without a readable manifest,
 *  the layer's `font_*` strings as stored. */
function motifSlots(params: MotifParams, manifest: Pick<Manifest, 'props_schema'> | null): string[] {
  if (manifest) return motifFontSlots(manifest, params.props).map(s => s.css)
  return Object.entries(params.props).filter((e): e is [string, string] => e[0].startsWith('font_') && typeof e[1] === 'string').map(([, v]) => v)
}

/** What changes the uses, as one string: a publish compares it with the last
 *  one and walks again only when it moved. Each Text layer contributes its
 *  family list, weight, italic and the distinct characters it draws (typing
 *  a letter already there changes nothing); each Motif layer its stored
 *  `font_*` props, the distinct characters of its other string props and its
 *  Motif's revision (which carries the manifest's defaults); and the
 *  exclusion list. Reads no manifest: it runs per publish. */
export function fontUseKey(project: Pick<Project, 'compositions' | 'settings'> & { motifs?: Project['motifs'] }): string {
  const parts: string[] = [JSON.stringify(project.settings.excluded_fonts ?? [])]
  for (const { layer } of eachLayer(project)) {
    const p = layer.params
    if (p.kind === 'Text') parts.push(textKey(layer.id, p))
    else if (p.kind === 'Motif') {
      const strings = Object.entries(p.props).filter((e): e is [string, string] => typeof e[1] === 'string')
      const fonts = strings.filter(([k]) => k.startsWith('font_'))
      const drawn = drawnOf(strings.filter(([k]) => !k.startsWith('font_')).map(([, v]) => v))
      parts.push(`${layer.id}\0${p.motif_id}\0${project.motifs?.[p.motif_id]?.revision ?? ''}\0${JSON.stringify(fonts)}\0${drawn.join(',')}`)
    }
  }
  return parts.join('\u0001')
}

function textKey(layerId: string, p: TextParams): string {
  return `${layerId}\0${p.font.family}\0${p.font.weight}\0${p.font.italic ? 1 : 0}\0${drawnCodePoints(p).join(',')}`
}

function sameIdentity(a: { weight: FaceWeight; italic: boolean }, b: { weight: FaceWeight; italic: boolean }): boolean {
  if (a.italic !== b.italic) return false
  if (typeof a.weight === 'number' || typeof b.weight === 'number') return a.weight === b.weight
  return a.weight[0] === b.weight[0] && a.weight[1] === b.weight[1]
}

/** Whether `Fonts/` already holds this face: a project face answering to one
 *  of its families with the same weight and italic, whatever its version. */
function presentInProject(faces: readonly FaceIndexEntry[], face: FaceIndexEntry): boolean {
  const keys = new Set(face.families.map(fontFamilyKey))
  return faces.some(f => f.source === 'project' && sameIdentity(f, face) && f.families.some(n => keys.has(fontFamilyKey(n))))
}

/** The project's requests: one per Text (family list, weight, italic), and one
 *  per Motif (font slot list, shipped families). A Motif slot walks at
 *  Regular upright: its CSS picks the weights it draws, which the app cannot
 *  see, and no prop names them. */
function requests(project: Pick<Project, 'compositions'>, manifestOf: MotifFontManifest): { text: Request[]; motif: Request[] } {
  const text = new Map<string, Request>()
  const motif = new Map<string, Request>()
  const add = (into: Map<string, Request>, key: string, make: () => Omit<Request, 'codePoints' | 'layerIds'>, codePoints: Iterable<number>, layerId: string) => {
    let r = into.get(key)
    if (!r) into.set(key, r = { ...make(), codePoints: new Set(), layerIds: [] })
    for (const cp of codePoints) r.codePoints.add(cp)
    if (!r.layerIds.includes(layerId)) r.layerIds.push(layerId)
  }
  for (const { layer } of eachLayer(project)) {
    const p = layer.params
    if (p.kind === 'Text') {
      const weight = requestWeight(p.font.weight)
      const italic = requestItalic(p.font.italic)
      add(text, `${p.font.family}\0${weight}\0${italic ? 1 : 0}`, () => ({ css: p.font.family, weight, italic, shipped: new Set() }), drawnCodePoints(p), layer.id)
    } else if (p.kind === 'Motif') {
      const manifest = manifestOf(p.motif_id)
      const shipped = [...new Set((manifest?.fonts ?? []).map(f => fontFamilyKey(f.family)))].sort()
      const drawn = drawnOf(motifTexts(p, manifest))
      for (const css of motifSlots(p, manifest)) {
        add(motif, `${css}\0${shipped.join('\0')}`, () => ({ css, weight: 400, italic: false, shipped: new Set(shipped) }), drawn, layer.id)
      }
    }
  }
  return { text: [...text.values()], motif: [...motif.values()] }
}

export async function fontUses(input: FontUsesInput): Promise<FontUses> {
  const { project, faces } = input
  const manifests = new Map<string, ReturnType<MotifFontManifest>>()
  const manifestOf = (id: string) => {
    if (!manifests.has(id)) manifests.set(id, input.motifManifest(id))
    return manifests.get(id) ?? null
  }
  const excluded = new Set((project.settings.excluded_fonts ?? []).map(fontFamilyKey))
  const coverageOf = new Map<string, Promise<Coverage | null>>()
  const coverage = (sha: string) => {
    let c = coverageOf.get(sha)
    if (!c) { c = input.coverage(sha).catch(() => null); coverageOf.set(sha, c) }
    return c
  }
  const draws = new Set<string>()
  const missing = new Map<string, MissingFontUse>()
  const miss = (family: string, weight: number | null, italic: boolean | null, layerIds: readonly string[]) => {
    const key = `${fontFamilyKey(family)}\0${weight}\0${italic}`
    let use = missing.get(key)
    if (!use) { use = { family, weight, italic, layer_ids: [] }; missing.set(key, use) }
    for (const id of layerIds) if (!use.layer_ids.includes(id)) use.layer_ids.push(id)
  }

  /** Each character goes down the list to the first leaf whose face draws it,
   *  stopping at a bundled, generic or shipped leaf; that face is a use.
   *  Returns the request's missing leaves. */
  const walk = async (r: Request): Promise<string[]> => {
    const leaves = parseFamilyList(r.css)
    const stops = leaves.map(leaf => isBundledFamily(leaf) || isGenericFamily(leaf) || r.shipped.has(fontFamilyKey(leaf)))
    const resolved = leaves.map((leaf, i) => (stops[i] ? null : resolveFace(faces, leaf, r.weight, r.italic)))
    const covers = await Promise.all(resolved.map(face => (face ? coverage(face.sha256) : Promise.resolve(null))))
    for (const cp of r.codePoints) {
      for (let i = 0; i < leaves.length; i++) {
        if (stops[i]) break
        const face = resolved[i]
        const cover = covers[i]
        if (face && cover && hasGlyph(cover, cp)) { draws.add(face.sha256); break }
      }
      // No leaf draws it: the bundled tail or the browser's default does,
      // which is no use.
    }
    return missingLeaves(leaves, leaf => r.shipped.has(fontFamilyKey(leaf)) || familyFaces(faces, leaf).length > 0).missing
  }

  const { text, motif } = requests(project, manifestOf)
  for (const r of text) for (const family of await walk(r)) miss(family, r.weight, r.italic, r.layerIds)
  for (const r of motif) for (const family of await walk(r)) miss(family, null, null, r.layerIds)

  const bySha = new Map(faces.map(f => [f.sha256, f]))
  const collect = [...draws].filter((sha) => {
    const face = bySha.get(sha)
    return !!face && face.source === 'system'
      && !face.families.some(n => excluded.has(fontFamilyKey(n)))
      && !presentInProject(faces, face)
  }).sort()
  const missingList = [...missing.values()].sort((a, b) =>
    a.family.localeCompare(b.family) || (a.weight ?? 0) - (b.weight ?? 0) || Number(a.italic) - Number(b.italic))
  return { collect, missing: missingList }
}
