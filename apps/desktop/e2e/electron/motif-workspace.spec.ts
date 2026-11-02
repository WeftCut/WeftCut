import { test, expect } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PNG } from 'pngjs';
import { launchApp, tmpDir } from './helpers/driver';
test('MCP workspace: linked edits, binary round-trip, revision conflicts and a publication the user approves', async () => {
    test.setTimeout(90000);
    const directory = tmpDir('motif-author-directory-');
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ name: 'Linked', size: [64, 64], default_duration_s: 1, props_schema: {} }));
    writeFileSync(path.join(directory, 'index.html'), `<html><body><script>motif.define({async setup(){document.body.style.background=(await(await fetch('./color.txt')).text()).trim()},frame(){}})</script></body></html>`);
    writeFileSync(path.join(directory, 'color.txt'), 'red');
    const { app, page } = await launchApp();
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    const client = new Client({ name: 'e2e-workspace', version: '0' }, { capabilities: {} });
    try {
        const info = await page.evaluate(() => (window as any).api.mcp.getInfo());
        await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }));
        const names = (await client.listTools()).tools.map(t => t.name);
        for (const old of ['write_motif_draft', 'amend_motif_draft', 'get_motif_source', 'import_motif', 'preview_motif_draft', 'create_edit_draft', 'begin_file_upload', 'write_file_chunk', 'read_file_transfer', 'delete_file_transfer', 'copy_motif_draft', 'publish_motif', 'approve_motif_proposal', 'reject_motif_proposal', 'motif_staleness_report', 'acknowledge_motif_staleness'])
            expect(names).not.toContain(old);
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            return JSON.parse((result.content as Array<{
                text: string;
            }>)[0].text);
        };
        const draft = await call('open_motif_draft', { source: { kind: 'directory', path: directory } });
        expect((await call('open_motif_draft', { source: { kind: 'directory', path: directory } })).motif_id).toBe(draft.motif_id);
        const preview = async (id: string) => {
            // One 64-px frame (width 64 keeps it at the canvas size) under the sheet's 26-px label strip.
            const result = await client.callTool({ name: 'preview_motif', arguments: { motif_id: id, local_t_s: [0], width: 64 } });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            const content = result.content as Array<{
                type: string;
                data: string;
                text: string;
            }>;
            const png = PNG.sync.read(Buffer.from(content.find(c => c.type === 'image')!.data, 'base64'));
            const at = ((26 + 32) * 64 + 32) * 4;
            return { color: [...png.data.subarray(at, at + 4)], ...JSON.parse(content.find(c => c.type === 'text')!.text) };
        };
        expect((await preview(draft.motif_id)).color).toEqual([255, 0, 0, 255]);
        writeFileSync(path.join(directory, 'color.txt'), 'lime');
        // Observe the app-owned mirror, not a pull that would refresh the source.
        await expect.poll(() => readFileSync(path.join(userData, 'data', 'motifs', 'drafts', draft.motif_id, 'color.txt'), 'utf8'), { timeout: 10000 }).toBe('lime');
        const green = await preview(draft.motif_id);
        expect(green.color).toEqual([0, 255, 0, 255]);
        expect(green.revision).not.toBe(draft.revision);
        const stale = await client.callTool({ name: 'update_motif_files', arguments: { motif_id: draft.motif_id, expected_revision: draft.revision, files: [{ path: 'color.txt', text: 'black' }] } });
        expect(stale.isError).toBe(true);
        const edited = await call('update_motif_files', { motif_id: draft.motif_id, expected_revision: green.revision, files: [{ path: 'color.txt', base64: Buffer.from('blue').toString('base64') }] });
        expect(readFileSync(path.join(directory, 'color.txt'), 'utf8')).toBe('blue');
        expect((await call('read_motif', { motif_id: draft.motif_id, path: 'color.txt' })).text).toBe('blue');
        expect((await preview(draft.motif_id)).color).toEqual([0, 0, 255, 255]);
        // install_motif proposes; the library waits for the user (ADR 0046).
        const proposal = await call('install_motif', { motif_id: draft.motif_id, expected_revision: edited.revision });
        expect(proposal).toMatchObject({ state: 'awaiting_approval', target: { new_id: 'linked' } });
        expect(await call('install_motif', { motif_id: draft.motif_id, expected_revision: edited.revision })).toEqual(proposal);
        expect((await call('list_motifs', { status: 'installed' })).map((m: { id: string }) => m.id)).not.toContain('linked');
        // The operator approves as the card's button does (e2e test hook).
        const publishedId = await page.evaluate((motifId) => (window as any).__weftcutTest.motifDecideProposal({ motifId, approve: true }), draft.motif_id);
        expect(publishedId).toBe('linked');
        const published = { motif_id: publishedId as string };
        const row = (await call('list_motifs', { status: 'draft' })).find((m: { id: string }) => m.id === draft.motif_id);
        expect(row.publication).toMatchObject({ state: 'approved', version: 1 });
        const zip = path.join(tmpDir('motif-export-'), 'published.zip');
        await call('export_motif', { motif_id: published.motif_id, path: zip });
        const copied = await call('open_motif_draft', { source: { kind: 'zip', path: zip } });
        expect((await preview(copied.motif_id)).color).toEqual([0, 0, 255, 255]);
        writeFileSync(path.join(directory, 'manifest.json'), '{broken');
        expect((await call('read_motif', { motif_id: draft.motif_id })).diagnostic).toBeTruthy();
        expect((await client.callTool({ name: 'preview_motif', arguments: { motif_id: draft.motif_id, local_t_s: [0] } })).isError).toBe(true);
        expect((await preview(published.motif_id)).color).toEqual([0, 0, 255, 255]);
        await call('delete_motif', { motif_id: draft.motif_id });
        expect(readFileSync(path.join(directory, 'color.txt'), 'utf8')).toBe('blue');
    }
    finally {
        await client.close();
        await app.close();
    }
});
