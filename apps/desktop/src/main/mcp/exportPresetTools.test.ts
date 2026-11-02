import { describe, expect, it, vi } from 'vitest';
import { createAppSettingsStore, type AppSettingsFs } from '../app-settings';
import type { TsActorHost } from '../state/ts-actor-host';
import { handleCallTool } from './server';
import { EXPORT_PRESET_TOOL_DEFS } from './exportTools';

function setup() {
  const files = new Map<string, string>();
  const fs: AppSettingsFs = {
    exists: p => files.has(p), readFile: p => files.get(p)!,
    writeFile: (p, text) => { files.set(p, text); },
    rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a); }, mkdirp: () => {},
  };
  const deps = { fs, path: '/cfg/app_settings.json', dir: '/cfg' };
  const store = createAppSettingsStore(deps);
  const host = { openedProject: () => null, handleInvoke: vi.fn(async (channel, args) => {
    if (channel === 'app_settings_get') return store.get();
    if (channel === 'app_settings_set') return store.apply(args.patch);
    throw new Error(`Unexpected IPC ${channel}`);
  }) } as unknown as TsActorHost;
  const backend = { mcpCallTool: vi.fn(() => { throw new Error('No native route expected'); }) } as any;
  const call = (name: string, args: Record<string, unknown> = {}) => handleCallTool(backend, () => host, name, args) as Promise<any>;
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    return result.structuredContent;
  };
  return { call, ok, store, files, host, restart: () => createAppSettingsStore(deps) };
}

describe('MCP export preset library without an open project', () => {
  it('advertises portable snake_case settings with valid JSON Schema keywords', async () => {
    const s = setup();
    const listed = await s.ok('list_export_presets');
    expect(listed).toMatchObject({ default_preset_id: 'builtin:match', name_limit: 40 });
    expect(listed.presets).toHaveLength(4);
    expect(listed.presets.every((p: any) => p.read_only)).toBe(true);
    expect(listed.presets.filter((p: any) => p.is_default).map((p: any) => p.id)).toEqual(['builtin:match']);
    // The settings schema is advertised once, in the input schemas, not in every result.
    expect(listed).not.toHaveProperty('settings_schema');
    const create = EXPORT_PRESET_TOOL_DEFS.find(t => t.name === 'create_export_preset')!;
    expect(create.inputSchema).toMatchObject({ properties: { name: { maxLength: 40 }, settings: { additionalProperties: false, properties: {
      audio: { additionalProperties: false, properties: { sample_rate: expect.any(Object) } },
      custom_bitrate: { minimum: 1 },
    } } } });
    expect((create.inputSchema.properties as any).settings.properties).not.toHaveProperty('encoder_engine');
    expect((create.inputSchema.properties as any).settings.properties).not.toHaveProperty('hw_accel');
    expect(EXPORT_PRESET_TOOL_DEFS.map(t => t.name)).toEqual(['list_export_presets', 'create_export_preset', 'update_export_preset', 'delete_export_preset']);
    const annotations = (n: string) => EXPORT_PRESET_TOOL_DEFS.find(t => t.name === n)!.annotations;
    expect(annotations('delete_export_preset')).toMatchObject({ destructiveHint: true });
    expect(annotations('update_export_preset')).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(EXPORT_PRESET_TOOL_DEFS.find(t => t.name === 'list_export_presets')!.annotations?.readOnlyHint).toBe(true);
  });

  it('creates independent copies, patches audio, renames, persists defaults and recovers after deletion', async () => {
    const s = setup();
    const created = await s.ok('create_export_preset', { name: ' Review ', base_preset_id: 'builtin:fullhd', settings: { audio: { channels: 1 } } });
    const id = created.preset.id;
    expect(created.preset).toMatchObject({ name: 'Review', read_only: false, settings: {
      resolution_height: 1080, custom_bitrate: 8_000_000, audio: { channels: 1, bitrate: 192_000, sample_rate: 48_000 },
    } });
    expect(created.preset).not.toHaveProperty('bitrate_by_frame_rate');
    await s.ok('update_export_preset', { preset_id: id, default: true });
    await s.ok('update_export_preset', { preset_id: id, settings: { custom_bitrate: 6_000_000, include_audio: false } });
    const renamed = await s.ok('update_export_preset', { preset_id: id, name: 'R'.repeat(40) });
    expect(renamed.preset).toMatchObject({ is_default: true, name: 'R'.repeat(40), settings: {
      custom_bitrate: 6_000_000, include_audio: false, audio: { include: false, channels: 1, bitrate: 192_000 },
    } });
    const copy = await s.ok('create_export_preset', { name: 'Copy', base_preset_id: id });
    expect(copy.preset.id).not.toBe(id);
    expect(copy.preset.settings).toEqual(renamed.preset.settings);
    expect(s.restart().get().default_export_preset_id).toBe(id);
    const deleted = await s.ok('delete_export_preset', { preset_id: id });
    expect(deleted).toEqual({ deleted_preset_id: id, default_preset_id: 'builtin:match' });
    const listed = await s.ok('list_export_presets');
    expect(listed.presets.find((p: any) => p.id === copy.preset.id).settings).toEqual(copy.preset.settings);
    expect(listed.presets.find((p: any) => p.id === 'builtin:fullhd').settings.custom_bitrate).toBe(8_000_000);
    await s.ok('update_export_preset', { preset_id: 'builtin:uhd', default: true });
    expect(s.restart().get().default_export_preset_id).toBe('builtin:uhd');
  });

  it('renames, patches settings and sets the default in one write', async () => {
    const s = setup();
    const { preset } = await s.ok('create_export_preset', { name: 'Draft' });
    const writes = (s.host.handleInvoke as any).mock.calls.filter(([c]: [string]) => c === 'app_settings_set').length;
    const updated = await s.ok('update_export_preset', { preset_id: preset.id, name: 'Delivery', settings: { codec: 'hevc' }, default: true });
    expect(updated).toMatchObject({ default_preset_id: preset.id, preset: { id: preset.id, name: 'Delivery', is_default: true, settings: { codec: 'hevc' } } });
    expect((s.host.handleInvoke as any).mock.calls.filter(([c]: [string]) => c === 'app_settings_set').length).toBe(writes + 1);
    const stored = s.restart().get();
    expect(stored.default_export_preset_id).toBe(preset.id);
    expect(stored.export_presets?.[0]).toMatchObject({ name: 'Delivery', values: { codec: 'hevc' } });
  });

  it('refuses invalid input and built-in edits without changing the stored library', async () => {
    const s = setup();
    const { preset } = await s.ok('create_export_preset', { name: 'Existing' });
    const before = [...s.files];
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['create_export_preset', { name: '  existing  ' }, 'invalid_params'],
      ['create_export_preset', { name: 'x'.repeat(41) }, 'invalid_params'],
      ['create_export_preset', { name: ' ' }, 'invalid_params'],
      ['create_export_preset', { name: 'x', base_preset_id: null }, 'invalid_params'],
      ['create_export_preset', { name: 'x', base_preset_id: 'missing' }, 'ExportPresetNotFound'],
      ['create_export_preset', { name: 'x', settings: { output_path: '/tmp/out' } }, 'invalid_params'],
      ['create_export_preset', { name: 'x', settings: { encoder_engine: 'native' } }, 'invalid_params'],
      ['create_export_preset', { name: 'x', settings: { audio: { sampleRate: 48_000 } } }, 'invalid_params'],
      ['create_export_preset', { name: 'x', settings: { codec: 'prores', container: 'mp4' } }, 'invalid_params'],
      ['create_export_preset', { name: 'x', settings: { include_audio: true, audio: { include: false } } }, 'invalid_params'],
      ['update_export_preset', { preset_id: preset.id }, 'invalid_params'],
      ['update_export_preset', { preset_id: preset.id, settings: null }, 'invalid_params'],
      ['update_export_preset', { preset_id: preset.id, settings: { fps: -1 } }, 'invalid_params'],
      ['update_export_preset', { preset_id: 'builtin:hd', settings: {} }, 'invalid_params'],
      ['update_export_preset', { preset_id: 'builtin:hd', name: 'x' }, 'invalid_params'],
      ['update_export_preset', { preset_id: 'builtin:hd', name: 'x', default: true }, 'invalid_params'],
      ['update_export_preset', { preset_id: preset.id, default: false }, 'invalid_params'],
      ['update_export_preset', { preset_id: preset.id, name: 'Other', settings: { fps: -1 }, default: true }, 'invalid_params'],
      ['delete_export_preset', { preset_id: 'builtin:hd' }, 'invalid_params'],
      ['update_export_preset', { preset_id: 'missing', default: true }, 'ExportPresetNotFound'],
      ['delete_export_preset', { preset_id: 'missing' }, 'ExportPresetNotFound'],
      ['update_export_preset', { preset_id: 3, default: true }, 'invalid_params'],
      ['list_export_presets', { extra: true }, 'invalid_params'],
    ];
    // The last column is the variant for a missing preset, the code otherwise;
    // every refusal is in the error model's flat shape.
    for (const [name, args, expected] of cases) {
      const result = await s.call(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(typeof result.structuredContent.error, name).toBe('string');
      if (expected === 'ExportPresetNotFound') expect(result.structuredContent).toMatchObject({ code: 'invalid_params', error: expected });
      else expect(result.structuredContent.code).toBe(expected);
      expect([...s.files]).toEqual(before);
    }
  });

  it('an argument the tool does not take is named, with the export tool that takes it', async () => {
    const s = setup();
    const result = await s.call('update_export_preset', { preset_id: 'p', range: { t_start_us: 0, t_end_us: 1 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('update_export_preset does not take range');
    expect(result.content[0].text).toContain('start_export takes range');
    expect(result.structuredContent).toMatchObject({ code: 'invalid_params', error: 'UnknownArgument', field: 'range' });
    expect(result.structuredContent.options).toContainEqual({ action: 'call', tool: 'start_export', field: 'range' });
  });
});
