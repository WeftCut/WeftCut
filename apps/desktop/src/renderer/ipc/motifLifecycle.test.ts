import { describe, it, expect, vi, beforeEach } from 'vitest';
import { composeMotifHtml } from '../../shared/motifs/catalog';
const invoke = vi.fn();
vi.mock('@/bridge/ipc', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@/bridge/events', () => ({ listen: vi.fn() }));
import { getMotifSource, importMotif, listMotifCatalog, removeProjectMotif, saveToLibrary, updateMotifSource, updateProjectMotif } from './index';
beforeEach(() => invoke.mockReset());

describe('the Motif panel speaks the project/library channels', () => {
  it('saves to the library at the revision the user saw: replacing the confirmed version, or as a new Motif', async () => {
    invoke.mockResolvedValue({ motif_id: 'lower' });
    await saveToLibrary('lower', 'reviewed', { id: 'lower', version: 4 });
    // The user's own save publishes directly; MCP's install_motif only proposes.
    expect(invoke).toHaveBeenLastCalledWith('publish_motif', { motif_id: 'lower', expected_revision: 'reviewed', target_id: 'lower', expected_version: 4 });
    await saveToLibrary('badge', 'reviewed');
    expect(invoke).toHaveBeenLastCalledWith('publish_motif', { motif_id: 'badge', expected_revision: 'reviewed', as_new: true });
  });

  it('updates, removes and imports project Motifs on their own channels', async () => {
    invoke.mockResolvedValue({ motif_id: 'scene', revision: 'r' });
    expect(await updateProjectMotif('lower')).toEqual({ unfinished: null });
    expect(invoke).toHaveBeenLastCalledWith('update_project_motif', { motif_id: 'lower' });
    // Files that made no package were moved aside: where, for the panel to say.
    invoke.mockResolvedValueOnce({ motif_id: 'lower', revision: 'r', unfinished: 'Backups/motifs/unfinished/lower-1' });
    expect(await updateProjectMotif('lower')).toEqual({ unfinished: 'Backups/motifs/unfinished/lower-1' });
    await removeProjectMotif('lower');
    expect(invoke).toHaveBeenLastCalledWith('delete_motif', { motif_id: 'lower' });
    expect(await importMotif('C:/scene.zip')).toBe('scene');
    expect(invoke).toHaveBeenLastCalledWith('create_motif', { source: { kind: 'zip', path: 'C:/scene.zip' } });
  });

  it('edits a project Motif in place from the revision it read, in one manifest/HTML transaction', async () => {
    const manifest = { id: 'a', name: 'A', version: 1, size: [64, 64] as [number, number], default_duration_s: 1, props_schema: {} };
    const html = composeMotifHtml(manifest, '<body>hello</body>');
    invoke.mockResolvedValueOnce({ manifest, text: html, revision: 'old' }).mockResolvedValueOnce({ revision: 'new' });
    const source = await getMotifSource('a');
    expect(invoke).toHaveBeenNthCalledWith(1, 'read_motif', { motif_id: 'a', path: 'index.html' });
    expect(await updateMotifSource('a', source.html, source.revision)).toBe('new');
    expect(invoke).toHaveBeenLastCalledWith('update_motif_files', expect.objectContaining({ motif_id: 'a', expected_revision: 'old', files: expect.arrayContaining([{ path: 'index.html', text: html }]) }));
  });

  it('splits list_motifs into its groups; an untrusted project Motif carries its manifest, a broken one none', async () => {
    invoke.mockResolvedValue([
      { group: 'library', id: 'lower', name: 'Lower', version: 2, size: [64, 64], default_duration_s: 1, props_schema: {}, status: 'installed', content_hash: 'L', revision: 'L', in_project: 'lower', html: '<x>' },
      { group: 'project', id: 'lower', name: 'Lower', version: 1, size: [64, 64], default_duration_s: 1, props_schema: {}, status: 'ok', state: 'update_available',
        uid: 'u', from: { uid: 'u', version: 1, revision: 'P' }, path: '/home/u/Film/Motifs/lower', content_hash: 'P', revision: 'P', html: '<x>' },
      { group: 'project', id: 'gone', uid: 'v', status: 'missing', state: 'project_only', from: null, path: '/home/u/Film/Motifs/gone', revision: null },
      { group: 'project', id: 'torn', uid: 'w', status: 'invalid', state: 'project_only', from: null, path: '/home/u/Film/Motifs/torn', revision: null, diagnostic: 'index.html is missing' },
      { group: 'project', id: 'received', name: 'Received', version: 1, size: [1920, 1080], default_duration_s: 4, props_schema: {}, status: 'untrusted', state: 'project_only',
        uid: 'x', from: null, path: '/home/u/Film/Motifs/received', content_hash: 'R', revision: 'R', html: '<x>', diagnostic: 'not trusted on this machine' },
    ]);
    const catalog = await listMotifCatalog();
    expect(catalog.library).toEqual([{ group: 'library', id: 'lower', status: 'installed', revision: 'L', in_project: 'lower',
      motif: { id: 'lower', name: 'Lower', version: 2, size: [64, 64], default_duration_s: 1, props_schema: {}, content_hash: 'L' } }]);
    expect(catalog.project.map(r => [r.id, r.state, r.motif?.content_hash ?? null, r.diagnostic ?? null]))
      .toEqual([['lower', 'update_available', 'P', null], ['gone', 'project_only', null, null], ['torn', 'project_only', null, 'index.html is missing'],
        ['received', 'project_only', 'R', 'not trusted on this machine']]);
    expect(catalog.project.find(r => r.id === 'received')?.motif).toMatchObject({ name: 'Received', size: [1920, 1080], default_duration_s: 4 });
  });
});
