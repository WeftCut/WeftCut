// apps/desktop/src/main/mcp/motifToolDefs.ts
// TS-owned MCP tool defs + resource defs for the motif surface.
// inputSchemas are TS-owned: all 6 motif tool DEFS live here, and
// rust-catalog-snapshot.json carries no motif arms (do not expect a regenerated
// one to contain them). preview_motif_draft's def is TS-sourced like the others,
// but its EXECUTION routes 'rust' (the CDP capture special-case in server.ts).
//
// Schemas carry no meta-schema / title envelope and no format hints: an agent
// reads none of them, and every ListTools pays for them (mcp.description-budget).

export interface MotifToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MotifResourceDef {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export const MOTIF_TOOL_DEFS: ReadonlyArray<MotifToolDef> = [
  {
    name: 'list_motifs',
    description:
      'List every motif `add_motif_layer` can place — built-ins plus installed and draft user motifs. ' +
      'Returns `[{ id, name, version, size: [w, h], default_duration_s, props_schema, status, ' +
      'content_hash, has_params_ui, target_id? }]`; `status` is `builtin` | `installed` | `draft`. ' +
      'Read `props_schema` before `add_motif_layer` — unknown prop keys reject. Drafts are placeable ' +
      'immediately for preview.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_motif_source',
    description:
      'Read a Motif\'s source { manifest, html } — any built-in, installed, or draft. ' +
      'Read this before editing so you can base your changes on the current source. ' +
      '`id` comes from `list_motifs`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { description: 'The Motif id (from `list_motifs`).', type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'write_motif_draft',
    description:
      'Write a Motif draft from { manifest, html }. Returns `{ draft_id }`. The draft is ' +
      'placeable immediately (via `add_motif_layer`) for preview, and re-writable. `from` ' +
      '(optional) records an existing Motif id as the draft\'s UPDATE target so a later ' +
      '`install_motif {mode:\'update\'}` republishes over it; omit `from` for a brand-new ' +
      'Motif (installs as new). The manifest\'s `id`/`version` are ignored — app-assigned. ' +
      'Expose tweakable controls via `props_schema`.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          description:
            'Optional id of an existing Motif this draft will UPDATE on install (records it as the draft\'s target). Omit for a brand-new Motif (installs as new).',
          type: ['string', 'null'],
        },
        html: {
          description:
            'The HTML body. The manifest island is injected by the app; a `<script>motif.define({...})</script>` drives the render.',
          type: 'string',
        },
        manifest: {
          // `type` is load-bearing: an untyped field gets string-coerced by MCP
          // clients, forcing agents to send the manifest as a JSON-encoded
          // string (mcp.catalog-bijection.test.ts assertion 7 gates this).
          type: 'object',
          description:
            'The manifest object (`id`/`version` are app-assigned and ignored): `{ name, size: [w, h], default_duration_s, props_schema, ... }` — copy a built-in\'s from `get_motif_source`.',
        },
      },
      required: ['html', 'manifest'],
    },
  },
  {
    name: 'preview_motif_draft',
    description:
      'Render one frame of a Motif (draft / installed / built-in) as a base64 PNG, so you can SEE ' +
      'your output and self-correct. `id`, `t_sec` (content time); optional `props` (default: the ' +
      'manifest defaults) and `width`/`height` (default: the motif\'s own size). Needs the app\'s ' +
      'preview runtime; errors rather than hangs when it is not ready.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { description: 'Motif id (draft / installed / built-in).', type: 'string' },
        t_sec: { description: 'Content time in seconds to render (0 = first frame).', type: 'number' },
        props: { type: 'object', description: 'Props; omitted or `{}` uses the manifest defaults.' },
        width: { description: 'Render width; default the motif\'s manifest width.', minimum: 1, type: ['integer', 'null'] },
        height: { description: 'Render height; default the motif\'s manifest height.', minimum: 1, type: ['integer', 'null'] },
      },
      required: ['id', 't_sec'],
    },
  },
  {
    name: 'install_motif',
    description:
      'Install a draft. mode \'new\' publishes under the draft\'s own id; \'update\' ' +
      'republishes over the draft\'s recorded UPDATE target (set via `write_motif_draft`\'s ' +
      '`from`) — bumping its version so every placement re-renders, and rebinding + ' +
      'migrating current-project layers. Returns `{ motif_id }`.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: {
          description: 'The draft id (from `write_motif_draft`).',
          type: 'string',
        },
        mode: {
          description:
            '"new" (publish under the draft\'s own id) or "update" (republish over the draft\'s recorded target; fails if the draft has no target).',
          type: 'string',
          enum: ['new', 'update'],
        },
      },
      required: ['draft_id', 'mode'],
    },
  },
  {
    name: 'delete_motif',
    description:
      'Delete an installed or draft user Motif by id. Built-ins are rejected. Placed ' +
      'layers referencing it degrade to an error placeholder.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { description: 'The Motif id (from `list_motifs`).', type: 'string' },
      },
      required: ['id'],
    },
  },
]

export const MOTIF_RESOURCE_DEFS: ReadonlyArray<MotifResourceDef> = [
  {
    uri: 'motifs://current',
    name: 'Motif catalog',
    description: 'Built-in, installed, and draft Motifs (html stripped). Re-fetch after motifs:changed events.',
    mimeType: 'application/json',
  },
]
