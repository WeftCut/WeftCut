// apps/desktop/src/main/mcp/argCheck.test.ts
// The pre-dispatch argument gate for Rust-parsed tools. What it owes: every
// missing or mistyped TOP-LEVEL field in one sentence, in the tool's
// vocabulary — the alternative is serde's one-field-at-a-time text with the
// column of a buffer the caller never saw.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { argProblemMessage, schemaProblems } from './argCheck'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: Array<{ name: string; inputSchema?: unknown; input_schema?: unknown }>
}
const schemaOf = (name: string): unknown => {
  const t = rust.tools.find((x) => x.name === name)!
  return t.inputSchema ?? t.input_schema
}

describe('schemaProblems', () => {
  it('names every missing required field at once', () => {
    const out = schemaProblems({ required: ['text', 'voice'], properties: { text: { type: 'string' }, voice: { type: 'string' } } }, {})
    expect(out).toEqual(['missing required `text`', 'missing required `voice`'])
  })

  it('an explicit null on a field that is not required reads as omitted; on a required one it is a type fault', () => {
    const schema = { required: ['s'], properties: { n: { type: 'integer' }, s: { type: 'string' }, e: { type: 'string', enum: ['a', 'b'] } } }
    expect(schemaProblems(schema, { n: null, e: null, s: 'x' })).toEqual([])
    expect(schemaProblems(schema, { s: null })).toEqual(['`s` must be a string, got null'])
  })

  it('checks the type of every present field, honouring the nullable union', () => {
    const schema = { properties: { n: { type: ['integer', 'null'] }, s: { type: 'string' }, b: { type: 'boolean' }, o: { type: 'object' }, a: { type: 'array' } } }
    expect(schemaProblems(schema, { n: null, s: 'x', b: true, o: {}, a: [] })).toEqual([])
    expect(schemaProblems(schema, { n: 1.5 })).toEqual(['`n` must be an integer, got 1.5'])
    expect(schemaProblems(schema, { s: 3 })).toEqual(['`s` must be a string, got 3'])
    expect(schemaProblems(schema, { o: [] })).toEqual(['`o` must be an object, got an array'])
    expect(schemaProblems(schema, { a: {} })).toEqual(['`a` must be an array, got an object'])
    expect(schemaProblems(schema, { b: 'yes' })).toEqual(['`b` must be a boolean, got "yes"'])
  })

  it('checks enums and quotes the live options', () => {
    const schema = { properties: { voice: { type: 'string', enum: ['alloy', 'echo'] } } }
    expect(schemaProblems(schema, { voice: 'echo' })).toEqual([])
    expect(schemaProblems(schema, { voice: 'bob' })).toEqual(['`voice` must be one of "alloy" | "echo", got "bob"'])
  })

  it('descends one level into a nested object with its own properties', () => {
    const schema = { properties: { a: { type: 'object', required: ['layer_id'], properties: { layer_id: { type: 'string' }, t_us: { type: 'integer' } } } } }
    expect(schemaProblems(schema, { a: { t_us: 'now' } })).toEqual(['missing required `a.layer_id`', '`a.t_us` must be an integer, got "now"'])
  })

  it('lets an unknown extra key through — that is the real parser\'s call', () => {
    expect(schemaProblems({ properties: { x: { type: 'string' } } }, { y: 1 })).toEqual([])
  })

  it('a schema it does not understand constrains nothing', () => {
    expect(schemaProblems(undefined, { anything: 1 })).toEqual([])
    expect(schemaProblems({ type: 'object' }, { anything: 1 })).toEqual([])
  })
})

describe('against the live Rust catalog', () => {
  it('synthesize_speech {} names text and voice in one line, in the tool\'s words', () => {
    const msg = argProblemMessage('synthesize_speech', schemaOf('synthesize_speech'), {})
    expect(msg).toBe('synthesize_speech: missing required `text`; missing required `voice`')
  })

  it('import_media {} names path', () => {
    expect(argProblemMessage('import_media', schemaOf('import_media'), {})).toBe('import_media: missing required `path`')
  })

  it('a complete call passes', () => {
    expect(argProblemMessage('import_media', schemaOf('import_media'), { path: 'C:/x.mp4' })).toBeNull()
  })

  it('ping takes nothing and refuses nothing', () => {
    expect(argProblemMessage('ping', schemaOf('ping'), {})).toBeNull()
  })
})
