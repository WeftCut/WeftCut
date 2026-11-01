import { describe, it, expect, vi, beforeEach } from 'vitest';
import { composeMotifHtml } from '../../shared/motifs/catalog';
const invoke = vi.fn();
vi.mock('@/bridge/ipc', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@/bridge/events', () => ({ listen: vi.fn() }));
import { getMotifSource, amendMotifDraft, createEditDraft, copyMotifDraft, importMotif, installMotif } from './index';
beforeEach(() => invoke.mockReset());
describe('Motif editor uses the public file contracts', () => {
    it('retains the target version observed before update confirmation', async () => {
        invoke.mockResolvedValueOnce({ manifest: { version: 1 }, text: '', revision: 'reviewed' })
            .mockResolvedValueOnce({ manifest: { version: 5 }, text: '', revision: 'target' })
            .mockResolvedValueOnce({ motif_id: 'published' });
        await installMotif('draft', { kind: 'update', target_id: 'published' }, 'reviewed', 4);
        // The user's own Update publishes directly; MCP's install_motif only proposes.
        expect(invoke).toHaveBeenLastCalledWith('publish_motif', { motif_id: 'draft', expected_revision: 'reviewed', target_id: 'published', expected_version: 4 });
    });
    it('opens both a copied Motif and ZIP through one entry point', async () => {
        invoke.mockResolvedValue({ motif_id: 'draft', revision: 'r' });
        expect(await createEditDraft('source')).toBe('draft');
        expect(invoke).toHaveBeenLastCalledWith('open_motif_draft', { source: { kind: 'motif', motif_id: 'source' } });
        await importMotif('C:/scene.zip');
        expect(invoke).toHaveBeenLastCalledWith('open_motif_draft', { source: { kind: 'zip', path: 'C:/scene.zip' } });
    });
    it('copies a draft in one call, the copy source MCP clients use too', async () => {
        invoke.mockResolvedValue({ motif_id: 'copy', revision: 'r' });
        expect(await copyMotifDraft('draft')).toBe('copy');
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenLastCalledWith('open_motif_draft', { source: { kind: 'copy', motif_id: 'draft' } });
    });
    it('retains the read revision and submits one manifest/HTML transaction', async () => {
        const manifest = { id: 'a', name: 'A', version: 1, size: [64, 64] as [
                number,
                number
            ], default_duration_s: 1, props_schema: {} };
        const html = composeMotifHtml(manifest, '<body>hello</body>');
        invoke.mockResolvedValueOnce({ manifest, text: html, revision: 'old' }).mockResolvedValueOnce({ revision: 'new' });
        const source = await getMotifSource('a');
        expect(invoke).toHaveBeenNthCalledWith(1, 'read_motif', { motif_id: 'a', path: 'index.html' });
        expect(await amendMotifDraft('a', source.html, source.revision)).toBe('new');
        expect(invoke).toHaveBeenLastCalledWith('update_motif_files', expect.objectContaining({ motif_id: 'a', expected_revision: 'old', files: expect.arrayContaining([{ path: 'index.html', text: html }]) }));
    });
    it('publishes the revision shown by the UI, not an unreviewed later revision', async () => {
        invoke.mockResolvedValueOnce({ manifest: { version: 1 }, text: '', revision: 'newer' }).mockResolvedValueOnce({ motif_id: 'published' });
        await installMotif('draft', { kind: 'new' }, 'reviewed');
        expect(invoke).toHaveBeenNthCalledWith(1, 'read_motif', { motif_id: 'draft' });
        expect(invoke).toHaveBeenLastCalledWith('publish_motif', { motif_id: 'draft', expected_revision: 'reviewed' });
    });
});
