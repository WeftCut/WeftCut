// apps/desktop/src/main/mcp/hostResources.ts
// The resources the TS host serves itself, as `resources/list` and
// `resources/templates/list` advertise them. Kept apart from server.ts so the
// docs-coverage gate can read the list without the server.
//
// A TS def here WINS over the Rust static resource of the same URI
// (`mergeMcpResources` dedups by URI), which is how `project://tracks` says
// "envelopes" and means it, and how the per-composition scope is documented on
// the resource an agent actually lists.
//
// The templates are the parameterised families (`media://{id}/frame/{t_us}`
// and its kin): without `resources/templates/list` an agent finds them only
// when a tool's prose happens to name one.

const APP_JSON = 'application/json'

export const HOST_RESOURCE_DEFS = [
  { uri: 'project://composition', name: 'Composition', mimeType: APP_JSON,
    description: "The root composition's settings — id, label, canvas, fps, duration (+ pinned), sample rate, channels, colour space, background; no tracks. `?composition=<id>` reads a Group's." },
  { uri: 'project://tracks', name: 'Tracks', mimeType: APP_JSON,
    description: 'The root composition\'s tracks, each with its flags and its layers as ENVELOPES: { id, label, kind, t_start_us, t_end_us, src_in_us?, src_out_us?, enabled, locked, link_id, effects: [{ id, kind }], keyframed: [param_key] }. `?composition=<id>` for a Group\'s; project://layers/{id} for one layer in full.' },
  { uri: 'project://links', name: 'Links', mimeType: APP_JSON,
    description: "The root composition's links — { id, label?, members: [layer_id] }. `?composition=<id>` for a Group's." },
  { uri: 'project://transitions', name: 'Transitions', mimeType: APP_JSON,
    description: "The root composition's transitions — { id, kind, direction, from_layer, to_layer, duration_us, extended_us }. `?composition=<id>` for a Group's." },
  { uri: 'project://settings', name: 'Project settings', mimeType: APP_JSON,
    description: 'The editing preferences `set_project_settings` writes (auto_pair_audio_on_import, prefer_proxies, proxy_overrides, shot_review, pause_review, correction_script) plus `metadata` { name, created_at, modified_at, description }; modified_at moves on every recorded edit.' },
  { uri: 'effects://catalog', name: 'Effects catalog', mimeType: APP_JSON,
    description: 'Every effect kind `add_effect` takes — the visual kinds and the `audio.*` kinds — with each param\'s default and range (a unit or a sample region where it has one). The kinds are `add_effect`\'s enum, the params are `update_effect` keys and the `effects[<id>].params[<key>]` keyframe path.' },
  { uri: 'project://session', name: 'Work session', mimeType: APP_JSON,
    description: 'The active agent work session (or null): owner client, connection, reason, started_at, checkpoint — plus recent sessions and the history lock. Read it after AgentSessionBusy.' },
]

/** RFC 6570 templates for the parameterised resources. `{?composition}` is the
 *  form-style query: expand with a Group's id, or leave it out for the root. */
export const HOST_RESOURCE_TEMPLATES = [
  { uriTemplate: 'project://layers/{id}', name: 'Layer', mimeType: APP_JSON,
    description: 'One layer in full — envelope, params (kind-specific, with every animated track), effects — from whichever composition holds it.' },
  { uriTemplate: 'project://composition{?composition}', name: 'Composition settings', mimeType: APP_JSON,
    description: "A composition's settings by id (a Group's, from project://compositions); the root when the query is omitted." },
  { uriTemplate: 'project://tracks{?composition}', name: 'Tracks of a composition', mimeType: APP_JSON,
    description: "A composition's tracks with layer envelopes; the root when the query is omitted." },
  { uriTemplate: 'project://markers{?composition}', name: 'Markers of a composition', mimeType: APP_JSON,
    description: "A composition's markers, sorted by t_us; the root when the query is omitted." },
  { uriTemplate: 'project://links{?composition}', name: 'Links of a composition', mimeType: APP_JSON,
    description: "A composition's links; the root when the query is omitted." },
  { uriTemplate: 'project://transitions{?composition}', name: 'Transitions of a composition', mimeType: APP_JSON,
    description: "A composition's transitions; the root when the query is omitted." },
  { uriTemplate: 'media://{id}/thumbnail', name: 'Media thumbnail', mimeType: 'image/jpeg',
    description: 'The middle frame of a media item as JPEG (base64 blob). 404 with a hint until the derivative exists.' },
  { uriTemplate: 'media://{id}/frame/{t_us}', name: 'Media frame', mimeType: 'image/jpeg',
    description: 'One frame of a media item at a source-absolute time in µs, as JPEG (base64 blob); decoded on demand and cached.' },
  { uriTemplate: 'media://{id}/waveform', name: 'Media waveform', mimeType: 'application/octet-stream',
    description: 'The audio peaks file of a media item (binary, base64). 404 with a hint until generated.' },
  { uriTemplate: 'media://{id}/analysis', name: 'Media shot analysis', mimeType: APP_JSON,
    description: 'The deterministic shot report of a media item — { shots, cut_scores }, source-absolute — computed on a miss, shared with analyze_clip.' },
  { uriTemplate: 'media://{id}/description', name: 'Media scene descriptions', mimeType: APP_JSON,
    description: 'Cached scene descriptions of a media item under the app\'s current view — { covered_ranges, segments }; 404 until describe_clip has run.' },
]
