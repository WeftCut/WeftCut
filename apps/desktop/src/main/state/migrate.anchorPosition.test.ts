import { beforeAll, describe, expect, it } from 'vitest'
import { initEval } from '../../renderer/eval'
import { evaluatePosition } from '../../renderer/render/position'
import { resolveAnimated } from '../../renderer/render/animated'
import { staticPosition, type PositionAnimation } from '../../shared/position'
import { type Animated, type Segment } from '../../shared/keyframe'
import { anchorPivot } from '../../renderer/render/anchorPivot'
import { layerQuad } from '../../renderer/preview/gizmoGeometry'
import { STEPS, upgradeWire, type PositionBakeReport } from './migrate'
import { migrationEvaluation } from './migrationEvaluation'
import { blankProject, type Transform } from './model'
import { seededGen } from './ids'
import { withGroup, root } from './__tests__/fixtures/project'
import { loadProjectFromJson, serializeProjectToJson } from './persistence'
import { validate } from './validate'
import { defaultTransform } from './mutations/add'

beforeAll(initEval)
const stat = (value: number): Animated<number> => ({ mode: 'Static', value })
const curve = (a: number, b: number, segment: Segment = { kind: 'Linear' }): Animated<number> => ({
  mode: 'Keyframed', extrapolate: { before: 'PingPong', after: 'Loop' }, value: [a, b].map((value, i) => ({
    id: `10000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, t_us: i * 500_000, value, segment, continuity: 'Broken',
    in: { x: 0.7, y: 0.85, mode: 'Free' }, out: { x: 0.3, y: 0.1, mode: 'Free' },
  })),
})
function fixture(kind = 'VideoClip') {
  const transform: Transform = { ...defaultTransform(12, -20), scale_x: stat(-2), scale_y: stat(3),
    anchor_x: stat(0.25), anchor_y: stat(1.25), rotation_deg: stat(37) }
  const layer = { id: 'clip', t_start_us: 100_000, t_end_us: 1_100_000,
    params: { kind, media: 'media', motif_id: 'motif', motif_version: 1, composition: 'child', transform,
      flip_h: true, crop: { x: 0.2, y: 0.1, w: 0.5, h: 0.8 } } }
  const composition = { width: 1920, height: 1080, fps: { num: 30000, den: 1001 }, duration_us: 1_200_000, tracks: [{ layers: [layer] }] }
  const wire = { schema_version: 3, compositions: { root: composition, child: { ...composition, width: 640, height: 360, tracks: [] as { layers: (typeof layer)[] }[] } },
    media_pool: { media: { metadata: { video: { width: 640, height: 360 } } } } }
  return { wire, layer, transform }
}
function migrate(wire: ReturnType<typeof fixture>['wire']) {
  const reports: PositionBakeReport[] = []
  const result = upgradeWire(wire, 3, 4, STEPS, { ...migrationEvaluation, motifSize: () => [640, 360], onBake: r => reports.push(r) })
  return { wire: result.wire as typeof wire, reports }
}
const path: PositionAnimation = {
  mode: 'Path', progress: curve(0, 1, { kind: 'Spline' }),
  path: { nodes: [
    { id: 'a', point: { x: 12, y: -20 }, in_handle: { x: 0, y: 0 }, out_handle: { x: 70, y: -20 }, tangent_mode: 'Corner', segment: 'Cubic' },
    { id: 'b', point: { x: 250, y: 80 }, in_handle: { x: -40, y: 90 }, out_handle: { x: 0, y: 0 }, tangent_mode: 'Corner', segment: 'Line' },
  ] },
}

describe('schema v3 → v4 anchor Position', () => {
  it.each(['VideoClip', 'ImageOverlay', 'Motif', 'CompositionRef'])('translates %s using full source dimensions, independent of rotation/crop/flip', kind => {
    const { wire } = fixture(kind)
    const original = structuredClone(wire)
    const migrated = migrate(wire)
    expect(migrated.wire.compositions.root.tracks[0].layers[0].params.transform.position).toEqual(staticPosition(332, 1330))
    expect(migrated.reports).toEqual([])
    expect(wire).toEqual(original)
    expect(migrated.wire.schema_version).toBe(4)
    expect(upgradeWire(migrated.wire, 4, 4).wire).toBe(migrated.wire)
  })

  it('keeps Text unchanged and does not require source metadata', () => {
    const { wire } = fixture('Text')
    expect(migrate(wire).wire.compositions).toEqual(wire.compositions)
  })

  it('translates position curves without changing timing, tangents or extrapolation', () => {
    const { wire, transform } = fixture()
    transform.position = { mode: 'XY', x: curve(12, 100, { kind: 'Elastic', dir: 'InOut', amplitude: 1.2, period: 0.4 }), y: stat(-20) }
    const migrated = migrate(wire).wire.compositions.root.tracks[0].layers[0].params.transform.position
    expect(migrated).toEqual({ mode: 'XY', x: { ...transform.position.x, value: (transform.position.x as Extract<Animated<number>, { mode: 'Keyframed' }>).value.map(k => ({ ...k, value: k.value + 320 })) }, y: stat(1330) })
  })

  it('translates Path nodes and keeps handles/progress intact for a constant offset', () => {
    const { wire, transform } = fixture()
    transform.position = structuredClone(path)
    const position = migrate(wire).wire.compositions.root.tracks[0].layers[0].params.transform.position
    expect(position).toEqual({ ...path, path: { nodes: path.path.nodes.map(n => ({ ...n, point: { x: n.point.x + 320, y: n.point.y + 1350 } })) } })
  })

  it.each(['XY', 'Path'])('bakes %s with animated signed scale and anchor at every composition frame', mode => {
    const { wire, transform, layer } = fixture()
    transform.position = mode === 'Path' ? structuredClone(path) : { mode: 'XY', x: curve(12, 100, { kind: 'Bounce', dir: 'Out' }), y: stat(-20) }
    transform.scale_x = curve(-2, 3, { kind: 'Spline' })
    transform.anchor_y = curve(1.25, -0.5, { kind: 'Elastic', dir: 'Out', amplitude: 1.2, period: 0.3 })
    const { wire: migrated, reports } = migrate(wire)
    const after = migrated.compositions.root.tracks[0].layers[0].params.transform
    for (let frame = 3; frame < 33; frame++) {
      const at = Math.round(frame * 1e6 * 1001 / 30000) - layer.t_start_us
      const old = evaluatePosition(transform.position, at)
      const sx = resolveAnimated(transform.scale_x, at, 1), sy = resolveAnimated(transform.scale_y, at, 1)
      const ax = resolveAnimated(transform.anchor_x, at, 0.5), ay = resolveAnimated(transform.anchor_y, at, 0.5)
      const p = evaluatePosition(after.position, at)
      expect(p.x).toBeCloseTo(old.x + ax * 640 * Math.abs(sx), 8)
      expect(p.y).toBeCloseTo(old.y + ay * 360 * Math.abs(sy), 8)
      // Actual renderer pivot and rotated/flipped/cropped gizmo agree with the
      // old media geometry; this also checks migration ignores crop dimensions.
      expect(anchorPivot({ x: p.x, y: p.y, anchorX: ax, anchorY: ay, texW: 640, texH: 360 }).posX).toBe(p.x)
      const geometry = { x: p.x, y: p.y, naturalW: 640, naturalH: 360, scaleX: sx, scaleY: sy,
        anchorX: ax, anchorY: ay, rotationDeg: 37, flipX: true, flipY: false, visibleRect: layer.params.crop }
      const quad = layerQuad(geometry)
      const localX = (0.2 - ax) * 640 * -sx, localY = (0.1 - ay) * 360 * sy
      const radians = 37 * Math.PI / 180
      expect(quad[0].x).toBeCloseTo(old.x + ax * 640 * Math.abs(sx) + Math.cos(radians) * localX - Math.sin(radians) * localY, 8)
      expect(quad[0].y).toBeCloseTo(old.y + ay * 360 * Math.abs(sy) + Math.sin(radians) * localX + Math.cos(radians) * localY, 8)
    }
    expect(reports).toEqual([{ compositionId: 'root', layerId: 'clip', previousMode: mode, samples: expect.any(Number) }])
    expect(after.scale_x).toEqual(transform.scale_x)
  })

  it('includes nested Group rate/phase samples with exact fractional key times', () => {
    const { wire, transform, layer } = fixture()
    transform.scale_x = curve(1, 4, { kind: 'Spline' })
    layer.t_start_us = 0
    wire.compositions.child.tracks = [{ layers: [layer] }]
    const ref = { ...layer, id: 'ref', params: { ...layer.params, kind: 'CompositionRef', transform: defaultTransform(),
      src_in_us: 0, time_map: { kind: 'Affine', rate: { num: 1, den: 3 } }, source_phase: { in: { num: 1, den: 7 } } } }
    wire.compositions.root.tracks = [{ layers: [ref] }]
    const after = migrate(wire).wire.compositions.child.tracks[0].layers[0].params.transform.position
    for (let frame = 0; frame < 30; frame++) {
      const at = Math.round(frame * 1e6 * 1001 / 30000) / 3 + 1 / 7
      const old = evaluatePosition(transform.position, at)
      expect(evaluatePosition(after, at).x).toBeCloseTo(old.x + 160 * Math.abs(resolveAnimated(transform.scale_x, at, 1)), 8)
    }
    expect(after.mode === 'XY' && after.x.mode === 'Keyframed' && after.x.value.some(k => k.time_fraction)).toBe(true)
  })

  it('loads, reports, validates and saves a baked legacy Group through the real JSON boundary', () => {
    const gen = seededGen()
    const { p } = withGroup(blankProject(gen, 'legacy'), gen)
    p.schema_version = 3
    const ref = root(p).tracks.flatMap(t => t.layers).find(l => l.params.kind === 'CompositionRef')!
    if (ref.params.kind !== 'CompositionRef') throw new Error('expected Group')
    ref.params.transform.position = staticPosition(0, 0)
    ref.params.transform.scale_x = curve(1, 2)
    ref.params.transform.scale_y = curve(1, 2)
    const before = serializeProjectToJson(p)
    const migrated = loadProjectFromJson(before, { dir: '/home/u/Film' })
    expect(migrated.upgradedFrom).toBe(3)
    expect(migrated.bakedPositions).toHaveLength(1)
    expect(() => validate(migrated.project)).not.toThrow()
    const saved = serializeProjectToJson(migrated.project)
    const reopened = loadProjectFromJson(saved, { dir: '/home/u/Film' })
    expect(reopened.upgradedFrom).toBeNull()
    expect(reopened.bakedPositions).toEqual([])
    expect(serializeProjectToJson(reopened.project)).toBe(saved)
    expect(serializeProjectToJson(p)).toBe(before)
  })

  it('materializes the old zero fallback before translating an empty position curve', () => {
    const { wire, transform } = fixture()
    transform.position = { mode: 'XY', x: { mode: 'Keyframed', value: [], extrapolate: { before: 'Hold', after: 'Hold' } }, y: stat(-20) }
    expect(migrate(wire).wire.compositions.root.tracks[0].layers[0].params.transform.position).toEqual(staticPosition(320, 1330))
  })

  it('refuses missing dimensions or excessive samples without mutating the original', () => {
    const { wire, transform } = fixture()
    transform.scale_x = curve(1, 2)
    wire.compositions.root.duration_us = 200e6
    wire.compositions.root.tracks[0].layers[0].t_end_us = 200e6
    const before = structuredClone(wire)
    expect(() => migrate(wire)).toThrow('limit 4096')
    expect(wire).toEqual(before)
    expect(() => upgradeWire({ ...wire, media_pool: {} }, 3, 4)).toThrow('source dimensions unavailable')
  })
})
