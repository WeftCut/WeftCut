import { describe, it, expect } from 'vitest'
import { WorkspaceFailure } from '../../shared/workspaceErrors'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'
import { canonicalString } from './canonical'
import { serializeProject } from './serialize'
import { serializeProjectToJson, schemaGate, loadProjectFromJson } from './persistence'
import { root, withGroup } from './__tests__/fixtures/project'

const MARKER_BLUE = { r: 0, g: 128, b: 255, a: 255 }
/** The folder every load in this file opens from. */
const AT = { dir: '/home/u/Film' }

describe('serializeProjectToJson (mirror io/mod.rs:25 to_string_pretty)', () => {
  it('pretty-prints with 2-space indent and no trailing newline', () => {
    const p = blankProject(seededGen(), 'doc')
    const json = serializeProjectToJson(p)
    expect(json.startsWith(`{\n  "schema_version": ${SCHEMA_VERSION}`)).toBe(true)
    expect(json.endsWith('\n')).toBe(false)
    expect(json.includes('\n    ')).toBe(true) // nested 4-space level exists
  })
  it('round-trips through loadProjectFromJson canonically', () => {
    const p = blankProject(seededGen(), 'doc')
    const { project: back, upgradedFrom } = loadProjectFromJson(serializeProjectToJson(p), AT)
    expect(upgradedFrom).toBeNull()          // a file this build wrote needs no upgrade
    expect(canonicalString(serializeProject(back))).toBe(canonicalString(serializeProject(p)))
  })
  it('round-trips all three transition kinds (wire twin: native/src/state/transition.rs)', () => {
    const p = blankProject(seededGen(), 'doc')
    root(p).transitions.push(
      { id: 't1', from_layer: 'a', to_layer: 'b', duration_us: 1_000_000, kind: { kind: 'Crossfade' }, extended_us: 1_000_000 },
      { id: 't2', from_layer: 'a', to_layer: 'b', duration_us: 1_000_000, kind: { kind: 'Wipe', direction: 'left' }, extended_us: 0 },
      { id: 't3', from_layer: 'a', to_layer: 'b', duration_us: 1_000_000, kind: { kind: 'Slide', direction: 'up' }, extended_us: 500_000 },
    )
    const { project: back } = loadProjectFromJson(serializeProjectToJson(p), AT)
    expect(root(back).transitions).toEqual(root(p).transitions)
    expect(canonicalString(serializeProject(back))).toBe(canonicalString(serializeProject(p)))
  })

  // The three marker states a project can hold, on one file. Free is what every
  // marker used to be; anchored is the new tie; hibernating is an anchored
  // marker whose `src_us` has left its layer's window — a legal, retained state,
  // so a save/reload that quietly dropped or "repaired" it would destroy exactly
  // the information source-space anchoring exists to keep.
  it('round-trips free, anchored and hibernating markers alike', () => {
    const gen = seededGen()
    // A CompositionRef layer carries a source window without needing media.
    const { p, refLayerId } = withGroup(blankProject(gen, 'markers'), gen)
    const anchorLayer = root(p).tracks.flatMap((t) => t.layers).find((l) => l.id === refLayerId)!
    const window = anchorLayer.params as { src_in_us: number; src_out_us: number }
    root(p).markers = [
      { id: 'free', t_us: 0, end_t_us: null, label: 'free', note: '', color: MARKER_BLUE, anchor: null },
      { id: 'awake', t_us: 500_000, end_t_us: null, label: 'awake', note: 'inside the window', color: MARKER_BLUE,
        anchor: { layer: refLayerId, src_us: window.src_in_us + 500_000 } },
      { id: 'asleep', t_us: 900_000, end_t_us: null, label: 'asleep', note: 'past the out point', color: MARKER_BLUE,
        anchor: { layer: refLayerId, src_us: window.src_out_us + 1_000_000 } },
    ]
    const { project: back } = loadProjectFromJson(serializeProjectToJson(p), AT)
    expect(root(back).markers).toEqual(root(p).markers)
    expect(canonicalString(serializeProject(back))).toBe(canonicalString(serializeProject(p)))
  })
})

describe('schemaGate', () => {
  it('admits the current schema version, reporting it', () => {
    expect(schemaGate({ schema_version: SCHEMA_VERSION })).toBe(SCHEMA_VERSION)
  })
  it('admits an OLDER version — that is the migration chain\'s input, not an error', () => {
    expect(schemaGate({ schema_version: SCHEMA_VERSION - 1 })).toBe(SCHEMA_VERSION - 1)
  })
  it('refuses a newer version, reporting both versions rather than prose', () => {
    // The startup screen renders this in the user's language, so the refusal
    // carries the two numbers its copy interpolates and states nothing itself —
    // the file it fires on most often is one left by a different build of this
    // repo, where "update the app" would simply be wrong.
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION + 5 }))
      .toThrow(new WorkspaceFailure({ error: 'ProjectSchemaTooNew', found: SCHEMA_VERSION + 5, supported: SCHEMA_VERSION }))
  })
  it('refuses an absent, non-numeric or fractional version', () => {
    const unreadable = new WorkspaceFailure({ error: 'ProjectSchemaUnreadable' })
    expect(() => schemaGate({})).toThrow(unreadable)
    expect(() => schemaGate({ schema_version: '1' })).toThrow(unreadable)
    expect(() => schemaGate({ schema_version: 1.5 })).toThrow(unreadable)
    expect(() => schemaGate(null)).toThrow(unreadable)
    expect(() => schemaGate(42)).toThrow(unreadable)
  })
})

describe('loadProjectFromJson', () => {
  const wireAt = (v: number): string => {
    const p = blankProject(seededGen(), 'doc')
    return JSON.stringify({ ...(serializeProject(p) as object), schema_version: v })
  }

  it('throws on malformed JSON', () => {
    expect(() => loadProjectFromJson('{not json', AT)).toThrow()
  })
  it('reports no upgrade for a current-version file', () => {
    expect(loadProjectFromJson(wireAt(SCHEMA_VERSION), AT).upgradedFrom).toBeNull()
  })
  it('refuses a newer file at the gate, before the structural cast', () => {
    expect(() => loadProjectFromJson(wireAt(SCHEMA_VERSION + 1), AT))
      .toThrow(new WorkspaceFailure({ error: 'ProjectSchemaTooNew', found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION }))
  })
  it('refuses a version below the chain floor rather than guessing at its shape', () => {
    // v0 never shipped. The chain has no step for it and must not invent one.
    expect(() => loadProjectFromJson(wireAt(0), AT)).toThrow(/predates the oldest upgradable version/)
  })
})
