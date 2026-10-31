import { expect, it, vi } from 'vitest';
import { createServerRestart } from './serverRestart';

function setup() {
  const release = vi.fn();
  const deps = { busy: vi.fn(() => false), hold: vi.fn(() => release), saveResume: vi.fn(), clearResume: vi.fn(),
    flushSettings: vi.fn(), writeIntent: vi.fn(), clearIntent: vi.fn(), shutdown: vi.fn(async () => {}), quit: vi.fn() };
  return { deps, release, restart: createServerRestart(deps) };
}
it('flushes and saves the current project before committing restart, and deduplicates clicks', async () => {
  const { deps, restart } = setup();
  const first = restart(), second = restart();
  expect(second).toBe(first);
  const commit = await first;
  expect(deps.saveResume).toHaveBeenCalledOnce();
  expect(deps.shutdown).toHaveBeenCalledOnce();
  expect(deps.quit).not.toHaveBeenCalled();
  commit(); expect(deps.quit).toHaveBeenCalledOnce();
});
it('refuses active export/compute without writing, cancelling or shutting down', async () => {
  const { deps, restart } = setup();
  deps.busy.mockReturnValue(true);
  await expect(restart()).rejects.toMatchObject({ code: 'editor_busy' });
  expect(deps.hold).not.toHaveBeenCalled();expect(deps.shutdown).not.toHaveBeenCalled();
  expect(deps.writeIntent).not.toHaveBeenCalled();
});
it('honours the synchronous export admission gate', async () => {
  const { deps, restart } = setup();
  deps.hold.mockImplementation(() => { throw Object.assign(new Error('Export active'), { code: 'export_busy' }); });
  await expect(restart()).rejects.toMatchObject({ code: 'export_busy' });
  expect(deps.saveResume).not.toHaveBeenCalled();
});
it('a save failure keeps the editor usable and allows a later retry', async () => {
  const { deps, release, restart } = setup();
  deps.shutdown.mockRejectedValueOnce(new Error('Disk full'));
  await expect(restart()).rejects.toThrow('Disk full');
  expect(deps.clearIntent).toHaveBeenCalledOnce();expect(deps.clearResume).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();expect(deps.quit).not.toHaveBeenCalled();
  await restart();expect(deps.shutdown).toHaveBeenCalledTimes(2);
});
