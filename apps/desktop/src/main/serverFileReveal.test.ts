import { expect, it, vi } from 'vitest';
import { revealServerFile } from './serverFileReveal';

it('publishes a browser reveal with the private API credential, not the browser password', async () => {
  const key = 'test-api-key-' + 'a'.repeat(32), post = vi.fn(async () => new Response('{}'));
  await revealServerFile('/data/projects/demo/output/clip.mp4', { key: async () => key, post });
  expect(post).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ path: '/data/projects/demo/output/clip.mp4' }), key);
});
it('rejects relative targets, missing credentials and a rejected gateway response', async () => {
  const post = vi.fn(async () => new Response('{}', { status: 404 }));
  await expect(revealServerFile('../settings', { key: async () => 'a'.repeat(40), post })).rejects.toThrow('Invalid');
  await expect(revealServerFile('/data/exports/movie.mp4', { key: async () => '1234', post })).rejects.toThrow('authentication');
  expect(post).not.toHaveBeenCalled();
  await expect(revealServerFile('/data/exports/movie.mp4', { key: async () => 'a'.repeat(40), post })).rejects.toThrow('no longer exists');
});
