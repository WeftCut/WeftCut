// apps/desktop/bench/checklist.mjs
//
// Scores a bench task's intent checklist against the final project: the JSON
// `project://current` serves (src/main/state/model.ts `Project`). Pure: it
// reads nothing but its two arguments, so a run can be re-scored from its
// final.json after the vocabulary grows.
//
//   evaluateChecklist(task, finalProject) → [{ id, pass, detail }]
//
// `pass` is true / false, or null when the item is not machine-checkable (a
// `human` item, or a check the project data cannot settle). Those stay in the
// list for a person to review.
//
// Everything is read from the ROOT composition, which is what export renders.
// Role-tagged overlays are also found inside Groups (see `graphic_role`).
// Times in checks are seconds; layer times in the project are microseconds.
// Disabled layers and layers on hidden tracks do not count unless a selector
// sets `include_disabled`.
//
// ── Layer selector (`where`) ─────────────────────────────────────────────
//   layer_kind        'VideoClip' | 'Text' | 'Motif' | 'Audio' | 'ImageOverlay'
//                     | 'Color' | 'CompositionRef', or an array of them
//   caption           true: only layers on caption tracks; false: none of them
//   track_role        'ARoll' | 'BRoll' | 'Caption' | … | null (a plain track)
//   motif_id          a Motif id, or an array
//   motif_builtin     true: a built-in Motif (BUILTIN_MOTIF_IDS);
//                     false: an authored or installed one
//   graphic_role      the layer's role ('title', 'lower_third', …), an array
//                     of them, or null for untagged. In the counting checks
//                     (layer_count and the two built on it) a role also finds
//                     layers inside Groups, at their time on the root.
//   text              substring of the layer's visible text (case-sensitive)
//   text_regex        regex on the visible text; `text_flags` default "i"
//                     (visible text = Text content, or every string prop of a Motif)
//   starts_at_or_after_s, starts_before_s, ends_after_s, ends_at_or_before_s,
//   min_duration_s, max_duration_s
//   include_disabled  count disabled layers / hidden tracks too
//
// ── Check kinds ──────────────────────────────────────────────────────────
//   layer_count          { where, op, n }       op: '>=' '<=' '==' '>' '<' '!='
//   motif_layer_count    { op, n, where? }      layer_count over Motif layers
//   text_layer_matching  { text_regex, flags?, where?, op?, n? }
//                        Text or Motif layers, captions excluded unless
//                        where.caption says otherwise; default op '>=' n 1
//   text_layer_contains  { text }               (smoke tasks) a Text layer containing text
//   layer_span           { text | where, t_start_us?, t_end_us?, tolerance_us? }
//                        (smoke tasks) some matching layer spans exactly that
//   caption_track_present { min_cues? }         caption cues across caption tracks
//   caption_coverage     { min_fraction }       caption-cue union / programme length
//   captions_over_picture { min_fraction? }     share of caption time that has
//                        footage under it (stale cues after a cut fail this); default 1
//   timeline_duration    { min_s?, max_s?, measure? }
//                        measure 'content' (default): end of the last layer;
//                        'video': total time covered by VideoClip layers
//   no_gaps              { where?, tolerance_s? }  the union of matching layers
//                        (default VideoClip) runs from 0 to its end with no hole
//                        longer than the tolerance (default one frame)
//   no_gaps_on_track     { where?, tolerance_s? }  the same, per track
//   av_sync              { tolerance_s? }      every VideoClip whose media has
//                        sound has an Audio layer of the same media with the
//                        same timeline span and source window
//   pool_pictures_used   { min? }             distinct pool Images placed (an image
//                        layer or a Motif prop naming it); pass null without min
//   captions_visible     { }                  caption time not hidden by an opaque layer
//                        (footage off the A roll, a colour, a plate Motif, or a Group
//                        holding one) on a track above the caption track
//   scenes               { min, min_duration_s? }  scenes on the root: Groups of 2+ visual
//                        layers (not a title card) and drawn scenes (below), each at
//                        least min_duration_s long
//   layer_region         { where, x?: [lo, hi], y?: [lo, hi], require?: 'all' | 'any' }
//                        resting anchor of matching Text layers, as fractions of
//                        the frame; null when only Motifs matched (a Motif draws
//                        its own placement)
//   all_of / any_of      { checks: [check, ...] }
//   human                { }                   pass null; a person judges it
//
// A drawn illustration is a Motif tagged illustration with no picture: no
// `photo` or `media` prop, and no prop naming a pool item (an animation of a
// process, a diagram). A drawn scene is one on the root that is not drawn over
// the footage (`ground: none`) or scaled down: a frame-sized animation, a scene
// by itself (ADR 0134). Without its manifest the checklist cannot read its
// size; the audit can.

export const BUILTIN_MOTIF_IDS = Object.freeze([
  'countdown', 'lower-third', 'text-fx',
  'clipping-headline', 'clipping-stamp', 'clipping-quote', 'clipping-pointer', 'clipping-paper', 'clipping-scrap', 'clipping-reveal', 'clipping-sticker', 'clipping-network',
])

export const CHECK_KINDS = Object.freeze([
  'layer_count', 'motif_layer_count', 'text_layer_matching', 'text_layer_contains', 'layer_span',
  'caption_track_present', 'caption_coverage', 'captions_over_picture', 'timeline_duration',
  'no_gaps', 'no_gaps_on_track', 'av_sync', 'pool_pictures_used', 'captions_visible', 'scenes',
  'layer_region', 'all_of', 'any_of', 'human',
])

const US = 1e6
const s = (us) => +(us / US).toFixed(3)

// ── Reading the project ────────────────────────────────────────────────────

function rootOf(project) {
  const root = project?.compositions?.[project?.root_id]
  if (!root || !Array.isArray(root.tracks)) throw new Error('final project has no root composition')
  return root
}

function frameUs(root) {
  const fps = root.fps
  return fps && fps.num > 0 && fps.den > 0 ? (US * fps.den) / fps.num : US / 30
}

/** Every layer of the root with the track that holds it. */
function entries(root) {
  const out = []
  for (const track of root.tracks) for (const layer of track.layers ?? []) out.push({ track, layer })
  return out
}

function collectStrings(v, out) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out)
  return out
}

/** What a viewer could read off the layer: Text content, or a Motif's props. */
function visibleText(layer) {
  const p = layer.params ?? {}
  if (p.kind === 'Text') return String(p.content ?? '')
  if (p.kind === 'Motif') return collectStrings(p.props ?? {}, []).join('\n')
  return ''
}

const isCaptionTrack = (track) => track.role === 'Caption'
const asList = (v) => (Array.isArray(v) ? v : [v])

function matches(entry, where = {}) {
  const { track, layer } = entry
  const p = layer.params ?? {}
  if (!where.include_disabled && (layer.enabled === false || track.enabled === false)) return false
  if (where.layer_kind !== undefined && !asList(where.layer_kind).includes(p.kind)) return false
  if (where.caption !== undefined && isCaptionTrack(track) !== where.caption) return false
  if (where.track_role !== undefined && (track.role ?? null) !== where.track_role) return false
  if (where.motif_id !== undefined && (p.kind !== 'Motif' || !asList(where.motif_id).includes(p.motif_id))) return false
  if (where.graphic_role !== undefined && !asList(where.graphic_role).includes(p.graphic_role ?? null)) return false
  if (where.motif_builtin !== undefined && (p.kind !== 'Motif' || BUILTIN_MOTIF_IDS.includes(p.motif_id) !== where.motif_builtin)) return false
  // Matched with whitespace collapsed: a viewer reads "What is / a memory?" split
  // across two lines or two Motif props as one phrase.
  const seen = visibleText(layer).replace(/\s+/g, ' ')
  if (where.text !== undefined && !seen.includes(where.text)) return false
  if (where.text_regex !== undefined && !new RegExp(where.text_regex, where.text_flags ?? 'i').test(seen)) return false
  const t0 = layer.t_start_us, t1 = layer.t_end_us, d = t1 - t0
  if (where.starts_at_or_after_s !== undefined && t0 < where.starts_at_or_after_s * US) return false
  if (where.starts_before_s !== undefined && !(t0 < where.starts_before_s * US)) return false
  if (where.ends_after_s !== undefined && !(t1 > where.ends_after_s * US)) return false
  if (where.ends_at_or_before_s !== undefined && t1 > where.ends_at_or_before_s * US) return false
  if (where.min_duration_s !== undefined && d < where.min_duration_s * US) return false
  if (where.max_duration_s !== undefined && d > where.max_duration_s * US) return false
  return true
}

const select = (root, where) => entries(root).filter((e) => matches(e, where))

/** `entries`, plus the layers inside each enabled Group on the root, mapped
 *  to root time and clipped to the Group's window (nested Groups too). A title
 *  on a paper ground is a title even when the two are grouped as a card. */
function deepEntries(root, project, depth = 0) {
  const out = entries(root)
  if (!project || depth > 4) return out
  for (const { track, layer } of entries(root)) {
    if (layer.params?.kind !== 'CompositionRef' || layer.enabled === false || track.enabled === false) continue
    const child = project.compositions?.[layer.params.composition]
    if (!child) continue
    const w0 = layer.params.src_in_us ?? 0, w1 = w0 + (layer.t_end_us - layer.t_start_us)
    for (const e of deepEntries(child, project, depth + 1)) {
      const a = Math.max(e.layer.t_start_us, w0), b = Math.min(e.layer.t_end_us, w1)
      if (b <= a) continue
      out.push({ track: e.track, inGroup: true, layer: { ...e.layer, t_start_us: layer.t_start_us + a - w0, t_end_us: layer.t_start_us + b - w0 } })
    }
  }
  return out
}

/** `select` for role-tagged overlays: a `where` naming a `graphic_role` also
 *  finds them inside Groups. Other selectors read the root alone. */
const selectOverlays = (root, where, project) =>
  (where?.graphic_role !== undefined ? deepEntries(root, project) : entries(root)).filter((e) => matches(e, where))

function describe(list, max = 4) {
  const shown = list.slice(0, max).map(({ layer }) => {
    const text = visibleText(layer).replace(/\s+/g, ' ').trim()
    const what = layer.params?.kind === 'Motif' ? `Motif ${layer.params.motif_id}` : layer.params?.kind
    return `${what} ${s(layer.t_start_us)}-${s(layer.t_end_us)}s${text ? ` "${text.slice(0, 40)}"` : ''}`
  })
  return shown.join('; ') + (list.length > max ? `; +${list.length - max} more` : '')
}

/** Sorted, merged [start, end) intervals. */
function union(spans) {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const total = (ivs) => ivs.reduce((n, [a, b]) => n + (b - a), 0)

function intersectLength(a, b) {
  let n = 0, i = 0, j = 0
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1])
    if (hi > lo) n += hi - lo
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return n
}

function drawnIllustration(layer, project) {
  const p = layer.params ?? {}
  if (p.kind !== 'Motif' || p.graphic_role !== 'illustration') return false
  const pool = project?.media_pool ?? {}
  const props = p.props ?? {}
  return !('photo' in props) && !('media' in props) && !Object.values(props).some((v) => typeof v === 'string' && pool[v.split('@')[0]] !== undefined)
}
function drawnScene(layer, project) {
  const scaleOf = (v) => (v?.mode === 'Static' ? v.value : v?.value?.[0]?.value ?? 1)
  const t = layer.params?.transform
  return drawnIllustration(layer, project) && layer.params.props?.ground !== 'none' && (!t || (Math.abs(scaleOf(t.scale_x)) >= 0.95 && Math.abs(scaleOf(t.scale_y)) >= 0.95))
}
const titleCardOf = (ls) => ls.some((l) => l.params?.graphic_role === 'plate') && ls.every((l) => ['plate', 'title'].includes(l.params?.graphic_role))
const groupVisual = (layer, project) => (project?.compositions?.[layer.params.composition]?.tracks ?? []).filter((t) => !isCaptionTrack(t)).flatMap((t) => t.layers).filter((l) => l.enabled !== false && l.params?.kind !== 'Audio')
/** Scenes on the root: Groups of 2+ visual layers that are not a title card,
 *  and drawn scenes. */
function scenesOf(root, project) {
  return select(root, {}).filter(({ track, layer }) => layer.enabled !== false && !isCaptionTrack(track) && track.role !== 'ARoll' && (
    layer.params?.kind === 'CompositionRef' ? (() => { const v = groupVisual(layer, project); return v.length >= 2 && !titleCardOf(v) })() : drawnScene(layer, project)))
}

const spansOf = (list) => list.map(({ layer }) => [layer.t_start_us, layer.t_end_us])

/** End of the last enabled layer: how long the programme plays. */
function contentEndUs(root) {
  return select(root, {}).reduce((m, { layer }) => Math.max(m, layer.t_end_us), 0)
}

function compare(value, op, n) {
  switch (op) {
    case '>=': return value >= n
    case '<=': return value <= n
    case '==': return value === n
    case '!=': return value !== n
    case '>': return value > n
    case '<': return value < n
    default: throw new Error(`unknown op '${op}'`)
  }
}

/** Holes longer than `tol` in the union of `spans`, from 0 to its end. */
function holes(spans, tol) {
  const ivs = union(spans)
  const out = []
  let at = 0
  for (const [a, b] of ivs) {
    if (a - at > tol) out.push([at, a])
    at = Math.max(at, b)
  }
  return { holes: out, end: at }
}

// ── Check kinds ────────────────────────────────────────────────────────────

const KINDS = {
  layer_count(check, root, project) {
    const op = check.op ?? '>=', n = check.n ?? 1
    const hits = selectOverlays(root, check.where, project)
    return { pass: compare(hits.length, op, n), detail: `${hits.length} matching layer(s), want ${op} ${n}${hits.length ? `: ${describe(hits)}` : ''}` }
  },

  motif_layer_count(check, root, project) {
    return KINDS.layer_count({ ...check, where: { ...(check.where ?? {}), layer_kind: 'Motif' } }, root, project)
  },

  text_layer_matching(check, root, project) {
    const where = { caption: false, ...(check.where ?? {}), layer_kind: check.where?.layer_kind ?? ['Text', 'Motif'], text_regex: check.text_regex, text_flags: check.flags ?? check.where?.text_flags }
    return KINDS.layer_count({ op: check.op ?? '>=', n: check.n ?? 1, where }, root, project)
  },

  text_layer_contains(check, root) {
    return KINDS.layer_count({ op: '>=', n: 1, where: { layer_kind: 'Text', text: check.text } }, root)
  },

  layer_span(check, root) {
    const where = check.where ?? { layer_kind: ['Text', 'Motif'], text: check.text }
    const tol = check.tolerance_us ?? frameUs(root) / 2
    const hits = select(root, where)
    if (!hits.length) return { pass: false, detail: 'no matching layer' }
    const ok = hits.find(({ layer }) =>
      (check.t_start_us === undefined || Math.abs(layer.t_start_us - check.t_start_us) <= tol) &&
      (check.t_end_us === undefined || Math.abs(layer.t_end_us - check.t_end_us) <= tol))
    return { pass: !!ok, detail: ok ? describe([ok]) : `no matching layer spans the target: ${describe(hits)}` }
  },

  caption_track_present(check, root) {
    const tracks = root.tracks.filter(isCaptionTrack)
    const cues = select(root, { caption: true, layer_kind: 'Text' }).length
    const min = check.min_cues ?? 1
    return { pass: tracks.length > 0 && cues >= min, detail: `${tracks.length} caption track(s), ${cues} cue(s), want >= ${min}` }
  },

  caption_coverage(check, root) {
    const end = contentEndUs(root)
    if (end <= 0) return { pass: false, detail: 'empty timeline' }
    const covered = total(union(spansOf(select(root, { caption: true, layer_kind: 'Text' })).map(([a, b]) => [a, Math.min(b, end)])))
    const f = covered / end
    return { pass: f >= check.min_fraction, detail: `captions cover ${(f * 100).toFixed(1)}% of ${s(end)} s, want >= ${(check.min_fraction * 100).toFixed(0)}%` }
  },

  captions_over_picture(check, root) {
    const cues = union(spansOf(select(root, { caption: true, layer_kind: 'Text' })))
    const capTime = total(cues)
    if (!capTime) return { pass: false, detail: 'no captions' }
    const picture = union(spansOf(select(root, { layer_kind: 'VideoClip' })))
    const f = intersectLength(cues, picture) / capTime
    const min = check.min_fraction ?? 1
    return { pass: f >= min - 1e-9, detail: `${(f * 100).toFixed(1)}% of caption time has footage under it, want >= ${(min * 100).toFixed(0)}%` }
  },

  timeline_duration(check, root) {
    const measure = check.measure ?? 'content'
    const us = measure === 'video' ? total(union(spansOf(select(root, { layer_kind: 'VideoClip' })))) : contentEndUs(root)
    const v = us / US
    const ok = (check.min_s === undefined || v >= check.min_s) && (check.max_s === undefined || v <= check.max_s)
    const range = `[${check.min_s ?? '-'}, ${check.max_s ?? '-'}]`
    return { pass: ok, detail: `${measure} ${v.toFixed(3)} s, want ${range}` }
  },

  no_gaps(check, root) {
    const hits = select(root, check.where ?? { layer_kind: 'VideoClip' })
    if (!hits.length) return { pass: false, detail: 'no matching layers' }
    const tol = (check.tolerance_s !== undefined ? check.tolerance_s * US : frameUs(root)) + 1
    const h = holes(spansOf(hits), tol)
    return { pass: h.holes.length === 0, detail: h.holes.length ? `${h.holes.length} gap(s): ${h.holes.slice(0, 5).map(([a, b]) => `${s(a)}-${s(b)}s`).join(', ')}` : `continuous 0-${s(h.end)} s` }
  },

  no_gaps_on_track(check, root) {
    const hits = select(root, check.where ?? { layer_kind: 'VideoClip' })
    if (!hits.length) return { pass: false, detail: 'no matching layers' }
    const tol = (check.tolerance_s !== undefined ? check.tolerance_s * US : frameUs(root)) + 1
    const byTrack = new Map()
    for (const e of hits) byTrack.set(e.track, [...(byTrack.get(e.track) ?? []), e])
    const bad = []
    for (const [track, list] of byTrack) {
      const h = holes(spansOf(list), tol)
      if (h.holes.length) bad.push(`${track.label ?? track.role ?? track.id}: ${h.holes.slice(0, 3).map(([a, b]) => `${s(a)}-${s(b)}s`).join(', ')}`)
    }
    return { pass: bad.length === 0, detail: bad.length ? `gaps on ${bad.join('; ')}` : `${byTrack.size} track(s) without gaps` }
  },

  av_sync(check, root, project) {
    const tol = (check.tolerance_s !== undefined ? check.tolerance_s * US : frameUs(root)) + 1
    const pool = project.media_pool ?? {}
    const videos = select(root, { layer_kind: 'VideoClip' }).filter(({ layer }) => pool[layer.params.media]?.metadata?.audio != null)
    if (!videos.length) return { pass: null, detail: 'no VideoClip with sound to compare' }
    const audios = select(root, { layer_kind: 'Audio' }).map((e) => e.layer)
    const near = (a, b) => Math.abs(a - b) <= tol
    const off = []
    for (const { layer: v } of videos) {
      const twin = audios.find((a) => a.params.media === v.params.media &&
        near(a.t_start_us, v.t_start_us) && near(a.t_end_us, v.t_end_us) &&
        near(a.params.src_in_us, v.params.src_in_us) && near(a.params.src_out_us, v.params.src_out_us))
      if (!twin) off.push(`${s(v.t_start_us)}-${s(v.t_end_us)}s`)
    }
    return { pass: off.length === 0, detail: off.length ? `${off.length} of ${videos.length} clip(s) without matching sound: ${off.slice(0, 5).join(', ')}` : `${videos.length} clip(s) in sync` }
  },

  pool_pictures_used(check, root, project) {
    const pool = project.media_pool ?? {}
    const images = new Set(Object.entries(pool).filter(([, m]) => m.kind === 'Image').map(([id]) => id))
    const used = new Set()
    for (const { layer } of deepEntries(root, project)) {
      if (layer.enabled === false) continue
      const p = layer.params ?? {}
      if (p.kind === 'ImageOverlay' && images.has(p.media)) used.add(p.media)
      if (p.kind === 'Motif') for (const v of Object.values(p.props ?? {})) if (typeof v === 'string' && images.has(v.split('@')[0])) used.add(v.split('@')[0])
    }
    const label = (id) => pool[id]?.label ?? String(pool[id]?.path_abs ?? id).split(/[\\/]/).pop()
    return { pass: check.min === undefined ? null : used.size >= check.min, detail: `${used.size} of ${images.size} pool image(s) used` + (used.size ? `: ${[...used].map(label).join(', ')}` : '') + (check.min === undefined ? '' : `, want >= ${check.min}`) }
  },

  captions_visible(check, root, project) {
    const opaque = (l, depth = 0) => {
      const k = l.params?.kind
      if (k === 'VideoClip' || k === 'Color') return true
      if (k === 'Motif') return l.params.graphic_role === 'plate' || (depth === 0 && drawnScene(l, project))
      if (k === 'CompositionRef' && depth < 4) return (project.compositions?.[l.params.composition]?.tracks ?? []).filter((t) => !isCaptionTrack(t)).flatMap((t) => t.layers).some((x) => x.enabled !== false && opaque(x, depth + 1))
      return false
    }
    let cue = 0, hidden = 0
    root.tracks.forEach((ct, ci) => {
      if (!isCaptionTrack(ct)) return
      const cues = union(spansOf(ct.layers.filter((l) => l.enabled !== false).map((layer) => ({ layer }))))
      cue += total(cues)
      const covers = union(root.tracks.slice(ci + 1).filter((t) => !isCaptionTrack(t) && t.enabled !== false).flatMap((t) => t.layers).filter((l) => l.enabled !== false && opaque(l)).map((l) => [l.t_start_us, l.t_end_us]))
      hidden += intersectLength(cues, covers)
    })
    if (!cue) return { pass: null, detail: 'no captions' }
    return { pass: hidden === 0, detail: hidden ? `${s(hidden)} s of ${s(cue)} s of captions hidden under a layer on a track above them` : `all ${s(cue)} s of captions visible` }
  },

  scenes(check, root, project) {
    const all = scenesOf(root, project), long = all.filter(({ layer }) => layer.t_end_us - layer.t_start_us >= (check.min_duration_s ?? 0) * US)
    const what = ({ layer }) => `${layer.params.kind === 'CompositionRef' ? 'Group' : `drawn ${layer.params.motif_id}`} ${s(layer.t_start_us)}-${s(layer.t_end_us)}s`
    return { pass: long.length >= check.min, detail: `${long.length} scene(s)${long.length ? `: ${long.map(what).join('; ')}` : ''}, want >= ${check.min}` }
  },

  layer_region(check, root) {
    const hits = select(root, check.where)
    if (!hits.length) return { pass: false, detail: 'no matching layers' }
    const texts = hits.filter(({ layer }) => layer.params?.kind === 'Text')
    if (!texts.length) return { pass: null, detail: `only non-Text layers matched (${describe(hits)}); placement is drawn inside them` }
    const inRange = (v, r) => !r || (v >= r[0] && v <= r[1])
    const results = texts.map(({ layer }) => {
      const pos = restingAnchor(layer.params.transform?.position)
      if (!pos) return { layer, ok: null }
      const fx = pos.x / root.width, fy = pos.y / root.height
      return { layer, fx, fy, ok: inRange(fx, check.x) && inRange(fy, check.y) }
    })
    const known = results.filter((r) => r.ok !== null)
    if (!known.length) return { pass: null, detail: 'position not readable' }
    const pass = (check.require ?? 'all') === 'any' ? known.some((r) => r.ok) : known.every((r) => r.ok)
    return { pass, detail: known.map((r) => `"${visibleText(r.layer).slice(0, 30)}" at (${r.fx.toFixed(2)}, ${r.fy.toFixed(2)})`).join('; ') }
  },

  all_of(check, root, project) {
    const parts = check.checks.map((c) => evaluateCheck(c, root, project))
    const pass = parts.some((p) => p.pass === false) ? false : parts.some((p) => p.pass === null) ? null : true
    return { pass, detail: parts.map((p, i) => `[${i}] ${p.pass}: ${p.detail}`).join(' | ') }
  },

  any_of(check, root, project) {
    const parts = check.checks.map((c) => evaluateCheck(c, root, project))
    const pass = parts.some((p) => p.pass === true) ? true : parts.some((p) => p.pass === null) ? null : false
    return { pass, detail: parts.map((p, i) => `[${i}] ${p.pass}: ${p.detail}`).join(' | ') }
  },

  human(check) {
    return { pass: null, detail: check.note ?? 'needs a person to judge' }
  },
}

/** Where a layer rests once its entrance is over: the static position, the
 *  last key of an animated one, or the end of a motion path. */
function restingAnchor(position) {
  if (!position) return null
  const last = (a) => (a?.mode === 'Static' ? a.value : Array.isArray(a?.value) && a.value.length ? a.value[a.value.length - 1].value : undefined)
  if (position.mode === 'XY') {
    const x = last(position.x), y = last(position.y)
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  }
  if (position.mode === 'Path') {
    const nodes = position.path?.nodes ?? []
    return nodes.length ? nodes[nodes.length - 1].point : null
  }
  return null
}

function evaluateCheck(check, root, project) {
  const fn = KINDS[check?.kind]
  if (!fn) return { pass: null, detail: `unknown check kind '${check?.kind}'` }
  try {
    return fn(check, root, project)
  } catch (e) {
    return { pass: null, detail: `check failed to evaluate: ${e.message}` }
  }
}

/** One result per checklist item, in order. */
export function evaluateChecklist(task, finalProject) {
  const items = task?.checklist ?? []
  let root
  try {
    root = rootOf(finalProject)
  } catch (e) {
    return items.map((item) => ({ id: item.id, pass: item.check?.kind === 'human' ? null : false, detail: e.message }))
  }
  return items.map((item) => {
    const r = evaluateCheck(item.check, root, finalProject)
    return { id: item.id, pass: r.pass, detail: r.detail }
  })
}
