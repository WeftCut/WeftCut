import { EXPORT_SETTINGS_SCHEMA } from '../../shared/exportValidation';
import { exportWire } from '../../shared/exportJob';
import type { CatalogTool } from './mcpCatalog';
import { EXPORT_PRESET_NAME_LIMIT } from '../../shared/export-presets';

const HELP: Record<string, string> = {
  includeVideo: 'Include video.', includeAudio: 'Include audio; must agree with audio.include if both are set.',
  resolutionHeight: 'Output height in pixels, downscale only. Null follows composition; omission keeps saved setting.',
  fps: 'Integer output fps, no upsampling. Null follows composition.', codec: 'Output codec.', quality: 'Target bitrate preset; custom uses custom_bitrate.',
  customBitrate: 'Custom target bitrate in bits/second; null clears the saved target.', rateMode: 'Rate control; quality requires native software encoding.',
  maxBitrate: 'Native VBR peak ceiling in bits/second; null removes the cap.', bufferSize: 'Native VBV buffer in bits; null derives it from rate.',
  proresProfile: 'Profile for ProRes output.', dnxhrProfile: 'Profile for DNxHR output.', crf: 'Native constant quality value; null uses codec default.',
  preset: 'Native software encoder speed preset.', keyframeIntervalSec: 'Seconds between keyframes.', hwAccel: 'Auto prefers native hardware candidates; software forces CPU encoding.',
  encoderEngine: 'Auto selects native. MCP never prompts for or automatically switches to WebCodecs.', decodeEngine: 'Source decoding engine for this job.',
  bitDepth: 'Output bit depth. Delivery-codec 10-bit needs explicit experimental opt-in.', container: 'Video container; audio-only uses m4a or mka.',
  audio: 'Audio settings overrides.', include: 'Include audio; must agree with include_audio if both are set.', bitrate: 'Audio bitrate in bits/second.',
  sampleRate: 'Audio sample rate in Hz; null follows composition.', channels: 'Audio channels, mono or stereo; null follows composition.',
};
export function exportSettingsSchema(): Record<string, unknown> {
  const visit = (schema: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(schema).map(([k, v]) =>
    [k, k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, Record<string, unknown>>).map(([name, rule]) =>
      [Object.keys(exportWire({ [name]: null }, true) as object)[0]!, { ...visit(rule), description: HELP[name] }])) : v]));
  return visit(EXPORT_SETTINGS_SCHEMA);
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', minLength: 1, description: 'Application-session export job id.' };
const definition = (name: string, description: string, inputSchema: Record<string, unknown>, readOnlyHint: boolean, idempotentHint: boolean): CatalogTool & { description: string; inputSchema: Record<string, unknown> } => ({
  name, description, inputSchema, annotations: readOnlyHint ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false, idempotentHint },
});
export function exportPresetSettingsSchema(): Record<string, unknown> {
  const settings = exportSettingsSchema();
  const properties = { ...settings.properties as Record<string, unknown> };
  for (const key of ['encoder_engine', 'decode_engine', 'hw_accel']) delete properties[key];
  return { ...settings, properties };
}
const presetId = { type: 'string', minLength: 1, description: 'Exact preset ID from list_export_presets. Built-in IDs start with builtin:.' };
const presetName = { type: 'string', minLength: 1, maxLength: EXPORT_PRESET_NAME_LIMIT, description: 'Unique personal preset name, trimmed, at most 40 characters.' };
const presetSettings = { ...exportPresetSettingsSchema(), description: 'Partial portable output settings in snake_case. Excludes engines, hardware acceleration, paths and ranges. Omitted fields retain base values.' };
export const EXPORT_PRESET_TOOL_DEFS = [
  definition('list_export_presets', 'List built-in and personal export presets, complete portable settings, default ID and name limit. Available without a project.', schema({}), true, true),
  definition('create_export_preset', 'Create a reusable personal export preset. Copies base_preset_id (default builtin:match) and applies optional settings. Built-in base bitrate is copied as a fixed standard-frame-rate value; use get_export_options with preset_id to inspect project-adapted values. Does not change the default or project settings.', schema({ name: presetName, base_preset_id: presetId, settings: presetSettings }, ['name']), false, false),
  definition('update_export_preset', 'Patch a personal preset\'s portable settings. Existing projects and running jobs retain copied parameters. Built-ins are read-only.', schema({ preset_id: presetId, settings: presetSettings }, ['preset_id', 'settings']), false, true),
  definition('rename_export_preset', 'Rename a personal export preset. Built-ins are read-only.', schema({ preset_id: presetId, name: presetName }, ['preset_id', 'name']), false, true),
  definition('delete_export_preset', 'Delete a personal export preset. Deleting the default restores builtin:match. Existing projects are unchanged. Built-ins are read-only.', schema({ preset_id: presetId }, ['preset_id']), false, true),
  definition('set_default_export_preset', 'Set the built-in or personal preset used when a project has no saved export settings. Does not rewrite existing project settings.', schema({ preset_id: presetId }, ['preset_id']), false, true),
];
export const EXPORT_PRESET_TOOLS = new Set(EXPORT_PRESET_TOOL_DEFS.map(d => d.name));
export const EXPORT_TOOL_DEFS = [
  ...EXPORT_PRESET_TOOL_DEFS,
  definition('get_export_options', 'Read effective export settings and composition limits. Optional preset_id previews that preset without changing project settings; otherwise uses saved project settings, then the global default.', schema({ preset_id: presetId }), true, true),
  definition('start_export', 'Start an asynchronous export in the editor. Use one request_id per intent; reuse it when reconnecting. Poll get_export_status for the actual completed path. Default conflicts add a numeric suffix.', schema({
    request_id: { ...id, maxLength: 200, description: 'Unique export intent id. Reuse with identical arguments after reconnecting.' },
    output_path: { ...id, description: 'Absolute candidate file path. Omit for project/output/project-name.ext; explicit parent must exist.' },
    on_conflict: { enum: ['rename', 'fail'], description: 'Default rename adds a number. Fail requires the exact name. Neither overwrites.' },
    preset_id: presetId,
    settings: { ...exportSettingsSchema(), description: 'Partial per-job overrides, applied after preset_id. Without preset_id, uses saved project settings then the global default. Does not change the preset or saved project settings.' },
    range: { ...schema({ start_us: { type: 'integer', minimum: 0, description: 'Inclusive start in microseconds.' }, end_us: { type: 'integer', minimum: 1, description: 'Exclusive end in microseconds.' } }, ['start_us', 'end_us']), description: 'Span inside the root composition, snapped to its frame grid. Omit for the whole composition.' },
    allow_experimental_10bit: { type: 'boolean', description: 'Explicit opt-in for experimental HEVC/AV1 10-bit export.' },
  }), false, false),
  definition('render_frames', 'See the root composition as export renders it — footage, Motifs, text, captions and Groups composited — as JPEGs. Pass times_us, or layer_ids to judge beats over their whole span: each is sampled settled, in the middle, in its exit, and just after every cut or shot change under it. Returns one labelled contact sheet (default) or one image per frame, plus the times and why each was taken. Read-only; refused while an export runs. Seconds per frame.', schema({
    times_us: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 24, description: 'Composition times in µs.' },
    layer_ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 12, description: 'Root layers to sample over their spans (at most 24 frames in all).' },
    width: { type: 'integer', minimum: 160, maximum: 1920, description: 'Frame width in px; default 640.' },
    sheet: { type: 'boolean', description: 'One contact sheet (default true) or one image per frame.' },
  }), true, true),
  definition('get_export_status', 'Read an export job. Omit job_id to discover the current UI or MCP job. Records survive MCP reconnects until the app exits.', schema({ job_id: id }), true, true),
  definition('retry_export', 'Retry only finalization of an awaiting_retry job. Optional filename changes the basename in the same directory; keep its extension.', schema({ job_id: id, filename: { ...id, description: 'New basename including matching extension. Directory and encoded settings cannot change.' } }, ['job_id']), false, false),
  definition('cancel_export', 'Cancel or discard an export from either entry point. Cancellation drains active work before releasing the project edit lock; poll status until terminal.', schema({ job_id: id }, ['job_id']), false, true),
];
export const EXPORT_TOOLS = new Set(EXPORT_TOOL_DEFS.map(d => d.name));
