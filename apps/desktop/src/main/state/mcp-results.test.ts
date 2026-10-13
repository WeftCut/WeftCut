import { describe, expect, it } from 'vitest'
import { appendToolResultField, toolRecord } from './mcp-results'

describe('appendToolResultField', () => {
  const field = [{ tack_id: 't', label: 'x', change: 'moved' }]

  it('adds the field to a record’s structured content and its JSON text', () => {
    const out = appendToolResultField(toolRecord({ layer_id: 'l' }), 'affected_tacks', field)
    expect(out.structuredContent).toEqual({ layer_id: 'l', affected_tacks: field })
    expect(JSON.parse(out.content[0]!.text)).toEqual({ layer_id: 'l', affected_tacks: field })
  })

  it('appends a text block to a result with no JSON-object text, and leaves other shapes alone', () => {
    const image = { content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }] }
    expect(appendToolResultField(image, 'affected_tacks', field).content).toEqual([image.content[0], { type: 'text', text: JSON.stringify({ affected_tacks: field }) }])
    const list = { content: [{ type: 'text', text: '[1,2]' }], structuredContent: [1, 2] }
    const out = appendToolResultField(list, 'affected_tacks', field)
    expect(out.content).toHaveLength(2)
    expect(out.structuredContent).toEqual([1, 2])
    expect(appendToolResultField(null, 'k', 1)).toBeNull()
    expect(appendToolResultField('text', 'k', 1)).toBe('text')
  })
})
