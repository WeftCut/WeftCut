import { afterEach, expect, it, vi } from 'vitest';
import { invoke, invokeRaw, CommandPublicationError } from './ipc';
import { attachProjectPublication, ProjectPublicationClient } from '../state/projectPublication';

let detach: (() => void) | undefined;
afterEach(() => { detach?.(); detach = undefined; vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const version = { session: 1, revision: 1 };

it('returns the original command value only after the receipt reaches the view', async () => {
  const snapshot = deferred<{ version: typeof version; viewId: number; summary: string }>();
  let view = 'before';
  const read = vi.fn(() => snapshot.promise);
  const client = new ProjectPublicationClient({ read, apply: summary => { view = summary ?? ''; } });
  detach = attachProjectPublication(client);
  const invokePublished = vi.fn().mockResolvedValue({ value: { id: 'new-layer' }, publication: version });
  vi.stubGlobal('window', { api: { backend: { invokePublished } } });
  let returned = false;
  const result = invoke('add_color_layer').then(value => { returned = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false);
  snapshot.resolve({ version, viewId: 1, summary: 'edited' });
  expect(await result).toEqual({ id: 'new-layer' });
  expect(view).toBe('edited');
  // Event arrives after receipt: no additional snapshot and no value envelope leak.
  client.observe(version);
  await client.settle();
  expect(read).toHaveBeenCalledOnce();
  client.stop();
});

it('distinguishes an accepted edit from refresh failure and never resends it', async () => {
  const client = new ProjectPublicationClient({ read: async () => { throw new Error('offline'); }, apply: vi.fn() });
  detach = attachProjectPublication(client);
  const invokePublished = vi.fn().mockResolvedValue({ value: null, publication: version });
  vi.stubGlobal('window', { api: { backend: { invokePublished } } });
  await expect(invoke('update_marker')).rejects.toMatchObject({
    name: 'CommandPublicationError', accepted: true, command: 'update_marker',
  });
  expect(invokePublished).toHaveBeenCalledOnce();
  expect(new CommandPublicationError('edit', null).message).toContain('do not repeat');
  client.stop();
});

it('keeps rejected commands and no-op/read results separate from publication', async () => {
  const read = vi.fn();
  const client = new ProjectPublicationClient({ read, apply: vi.fn() });
  detach = attachProjectPublication(client);
  const invokePublished = vi.fn().mockRejectedValueOnce(new Error('locked'))
    .mockResolvedValueOnce({ value: 42, publication: null });
  vi.stubGlobal('window', { api: { backend: { invokePublished } } });
  await expect(invoke('delete_layer')).rejects.toThrow('locked');
  expect(await invoke('ping')).toBe(42);
  expect(read).not.toHaveBeenCalled();
  client.stop();
});

it('reads projections through raw transport without entering the barrier', async () => {
  const raw = vi.fn().mockResolvedValue({ version, summary: null });
  const published = vi.fn();
  vi.stubGlobal('window', { api: { backend: { invoke: raw, invokePublished: published } } });
  expect(await invokeRaw('project_publication')).toEqual({ version, summary: null });
  expect(published).not.toHaveBeenCalled();
});

it.each(['project_open', 'project_new_workspace', 'project_startup_open'])('allows %s before the workspace mirror mounts', async command => {
  const invokePublished = vi.fn().mockResolvedValue({ value: '/synthetic/project', publication: version });
  vi.stubGlobal('window', { api: { backend: { invokePublished } } });
  expect(await invoke(command)).toBe('/synthetic/project');
});
