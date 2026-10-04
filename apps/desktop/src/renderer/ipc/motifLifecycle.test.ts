import { describe, it, expect, vi, beforeEach } from 'vitest';
import { composeMotifHtml } from '../../shared/motifs/catalog';
const invoke = vi.fn();
vi.mock('@/bridge/ipc', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@/bridge/events', () => ({ listen: vi.fn() }));
import { getMotifSource, amendMotifDraft, createEditDraft, importMotif, installMotif } from './index';
beforeEach(() => invoke.mockReset());
describe('Motif editor uses the public file contracts', () => {
    it('retains the target version observed before update confirmation', async () => {
        invoke.mockResolvedValueOnce({ manifest: { version: 1 }, text: '', revision: 'reviewed' })
            .mockResolvedValueOnce({ manifest: { version: 5 }, text: '', revision: 'target' })
            .mockResolvedValueOnce({ motif_id: 'published' });
        await installMotif('draft', { kind: 'update', target_id: 'published' }, 'reviewed', 4);
        expect(invoke).toHaveBeenLastCalledWith('install_motif', { draft_id: 'draft', expected_revision: 'reviewed', target_id: 'published', expected_version: 4 });
    });
    it('opens both a copied Motif and ZIP through one entry point', async () => {
        invoke.mockResolvedValue({ draft_id: 'draft', revision: 'r' });
        expect(await createEditDraft('source')).toBe('draft');
        expect(invoke).toHaveBeenLastCalledWith('open_motif_draft', { source: { kind: 'motif', id: 'source' } });
        await importMotif('C:/scene.zip');
        expect(invoke).toHaveBeenLastCalledWith('open_motif_draft', { source: { kind: 'zip', path: 'C:/scene.zip' } });
    });
    it('retains the read revision and submits one manifest/HTML transaction', async () => {
        const manifest = { id: 'a', name: 'A', version: 1, size: [64, 64] as [
                number,
                number
            ], default_duration_s: 1, props_schema: {} };
        const html = composeMotifHtml(manifest, '<body>hello</body>');
        invoke.mockResolvedValueOnce({ manifest, text: html, revision: 'old' }).mockResolvedValueOnce({ revision: 'new' });
        const source = await getMotifSource('a');
        expect(await amendMotifDraft('a', source.html, source.revision)).toBe('new');
        expect(invoke).toHaveBeenLastCalledWith('update_motif_files', expect.objectContaining({ draft_id: 'a', expected_revision: 'old', files: expect.arrayContaining([{ path: 'index.html', text: html }]) }));
    });
    it('publishes the revision shown by the UI, not an unreviewed later revision', async () => {
        invoke.mockResolvedValueOnce({ manifest: { version: 1 }, text: '', revision: 'newer' }).mockResolvedValueOnce({ motif_id: 'published' });
        await installMotif('draft', { kind: 'new' }, 'reviewed');
        expect(invoke).toHaveBeenNthCalledWith(1, 'read_motif', { id: 'draft' });
        expect(invoke).toHaveBeenLastCalledWith('install_motif', { draft_id: 'draft', expected_revision: 'reviewed' });
    });
});
