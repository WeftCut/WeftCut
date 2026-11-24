// The project's font uses: which catalog families it draws with, so the
// project font store (./projectFonts.ts) copies every face of them into
// `Fonts/`; which families it asks for that resolve nowhere, so
// `project://session` and the log can name the layers they affect; and which
// it asks for that `Fonts/` does not carry, for the portability check. Only
// families that draw are uses, and a use is the whole family (ADR 0176).
// Matching a family to a face is ../../shared/fonts/resolve.ts and the missing
// rule is ../../shared/fonts/missing.ts; the walk here decides which of the
// listed families a layer's characters actually reach.

import { missingLeaves } from '../../shared/fonts/missing'
import { familyFaces, isBundledFamily, isGenericFamily, parseFamilyList, requestItalic, requestWeight, resolveFace } from '../../shared/fonts/resolve'
import type { FaceIndexEntry, FaceWeight } from '../../shared/fonts/types'
import type { Manifest } from '../../shared/motifs/catalog'
import { motifFontSlots } from '../../shared/motifs/fontProps'
import { eachLayer, type MotifParams, type Project, type TextParams } from '../state/model'
import { fontFamilyKey } from '../state/excludedFonts'
import { hasGlyph, type Coverage } from './sfnt'

/** A family the layers in `layer_ids` ask for that is absent: from this
 *  machine (`FontUses.missing`) or from the project folder
 *  (`FontUses.uncarried`). A Text layer's use carries its weight and italic;
 *  a Motif's is null for both: its own CSS picks the face. */
export interface MissingFontUse {
  family: string
  weight: number | null
  italic: boolean | null
  layer_ids: string[]
}

export interface FontUses {
  /** SHA-256 keys of the system faces of every family the project draws
   *  with that `Fonts/` lacks: what to copy. Sorted. */
  collect: string[]
  /** Families no `Fonts/` face, system face or bundled font answers to.
   *  Sorted by family, then weight. */
  missing: MissingFontUse[]
  /** What a copy of the folder lacks: `missing`, and each family the project
   *  draws with that has a face in `collect`, at the weight and italic of the
   *  layers drawing it (not of the absent face). One entry per family, weight
   *  and italic; sorted as `missing`. */
  uncarried: MissingFontUse[]
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
  /** Family keys the Motif's package ships: they draw in the page, so they are
   *  never collected and never missing. Empty for Text. */
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
 *  (docs/motif-authoring.md § Style Motifs). */
function motifTexts(params: MotifParams, manifest: Pick<Manifest, 'props_schema'>): string[] {
  const out: string[] = []
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    if (spec.type !== 'string' || key.startsWith('font_')) continue
    const value = params.props[key]
    out.push(typeof value === 'string' ? value : spec.default)
  }
  return out
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
 *  Regular upright: the walk only asks which family draws a character, and
 *  the whole family is the use, whatever weights the Motif's CSS picks. */
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
      // Without its manifest the Motif draws nothing here, and which stored
      // strings are text and which are colours or choices is unknown. Its
      // folder coming back may move no revision: the font store walks again
      // on the folder change (`ProjectFontStore.motifFolderChanged`).
      const manifest = manifestOf(p.motif_id)
      if (!manifest) continue
      const shipped = [...new Set((manifest.fonts ?? []).map(f => fontFamilyKey(f.family)))].sort()
      const drawn = drawnOf(motifTexts(p, manifest))
      for (const { css } of motifFontSlots(manifest, p.props)) {
        add(motif, `${css}\0${shipped.join('\0')}`, () => ({ css, weight: 400, italic: false, shipped: new Set(shipped) }), drawn, layer.id)
      }
    }
  }
  return { text: [...text.values()], motif: [...motif.values()] }
}

/** Whether some layer asks for a family the catalog would answer: one before
 *  its list's first generic family that is neither bundled nor shipped by the
 *  Motif's package. Without one there is nothing to collect, whatever the
 *  system scan finds. */
export function asksCatalogFamily(project: Pick<Project, 'compositions'>, motifManifest: MotifFontManifest): boolean {
  const { text, motif } = requests(project, motifManifest)
  return [...text, ...motif].some((r) => {
    const leaves = parseFamilyList(r.css)
    const end = leaves.findIndex(isGenericFamily)
    return (end < 0 ? leaves : leaves.slice(0, end)).some(leaf => !isBundledFamily(leaf) && !r.shipped.has(fontFamilyKey(leaf)))
  })
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
  /** Who asks: a Text request's weight and italic, null for a Motif's. */
  type Asker = Pick<MissingFontUse, 'weight' | 'italic'> & { layerIds: readonly string[] }
  /** Families some character is drawn with, by their faces' first name, each
   *  with the requests drawing with it. */
  const drawn = new Map<string, Asker[]>()
  const missing = new Map<string, MissingFontUse>()
  const uncarried = new Map<string, MissingFontUse>()
  const note = (into: Map<string, MissingFontUse>, family: string, { weight, italic, layerIds }: Asker) => {
    const key = `${fontFamilyKey(family)}\0${weight}\0${italic}`
    let use = into.get(key)
    if (!use) { use = { family, weight, italic, layer_ids: [] }; into.set(key, use) }
    for (const id of layerIds) if (!use.layer_ids.includes(id)) use.layer_ids.push(id)
  }

  /** Each character goes down the list to the first leaf whose face draws
   *  it; that leaf's family is a use. A generic leaf ends the walk: Text
   *  draws the bundled chain in its place, a Motif's browser maps it to a
   *  font of the machine. A bundled or shipped leaf is passed over, never a
   *  use: whether it draws the character is not read, so a later leaf that
   *  can draw it is a use too, and nothing the page may reach is left behind.
   *  Notes the request's missing leaves. */
  const walk = async (r: Request, asker: Asker): Promise<void> => {
    const leaves = parseFamilyList(r.css)
    const end = leaves.findIndex(isGenericFamily)
    const walked = end < 0 ? leaves : leaves.slice(0, end)
    const own = (leaf: string) => isBundledFamily(leaf) || r.shipped.has(fontFamilyKey(leaf))
    const resolved = walked.map(leaf => (own(leaf) ? null : resolveFace(faces, leaf, r.weight, r.italic)))
    const covers = await Promise.all(resolved.map(face => (face ? coverage(face.sha256) : Promise.resolve(null))))
    const drew = new Set<string>()
    for (const cp of r.codePoints) {
      for (let i = 0; i < walked.length; i++) {
        const face = resolved[i]
        const cover = covers[i]
        // The family is the face's own first name, not the leaf's: a legacy
        // name such as "Segoe UI Semibold" names one face of "Segoe UI".
        if (face && cover && hasGlyph(cover, cp)) { drew.add(face.families[0] as string); break }
      }
      // No leaf draws it: the bundled tail or the browser's default does,
      // which is no use.
    }
    for (const family of drew) {
      const askers = drawn.get(family)
      if (askers) askers.push(asker)
      else drawn.set(family, [asker])
    }
    const absent = missingLeaves(leaves, leaf => r.shipped.has(fontFamilyKey(leaf)) || familyFaces(faces, leaf).length > 0).missing
    for (const family of absent) { note(missing, family, asker); note(uncarried, family, asker) }
  }

  const { text, motif } = requests(project, manifestOf)
  for (const r of text) await walk(r, { weight: r.weight, italic: r.italic, layerIds: r.layerIds })
  for (const r of motif) await walk(r, { weight: null, italic: null, layerIds: r.layerIds })

  const collect = new Set<string>()
  for (const [family, askers] of drawn) {
    let lacking = false
    for (const face of familyFaces(faces, family)) {
      if (face.source === 'system' && !face.families.some(n => excluded.has(fontFamilyKey(n))) && !presentInProject(faces, face)) {
        collect.add(face.sha256)
        lacking = true
      }
    }
    if (lacking) for (const asker of askers) note(uncarried, family, asker)
  }
  const sorted = (uses: Map<string, MissingFontUse>) => [...uses.values()].sort((a, b) =>
    a.family.localeCompare(b.family) || (a.weight ?? 0) - (b.weight ?? 0) || Number(a.italic) - Number(b.italic))
  return { collect: [...collect].sort(), missing: sorted(missing), uncarried: sorted(uncarried) }
}
