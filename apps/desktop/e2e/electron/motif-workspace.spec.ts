import { test, expect } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PNG } from 'pngjs';
import { launchApp, tmpDir } from './helpers/driver';
test('MCP workspace: linked edits, binary round-trip, revision conflicts and retained publication', async () => {
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
        for (const old of ['write_motif_draft', 'amend_motif_draft', 'get_motif_source', 'import_motif', 'preview_motif_draft', 'create_edit_draft'])
            expect(names).not.toContain(old);
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            return JSON.parse((result.content as Array<{
                text: string;
            }>)[0].text);
        };
        const draft = await call('open_motif_draft', { source: { kind: 'directory', path: directory } });
        expect((await call('open_motif_draft', { source: { kind: 'directory', path: directory } })).draft_id).toBe(draft.draft_id);
        const preview = async (id: string) => {
            const result = await client.callTool({ name: 'preview_motif', arguments: { id, t_sec: 0 } });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            const content = result.content as Array<{
                type: string;
                data: string;
                text: string;
            }>;
            const png = PNG.sync.read(Buffer.from(content.find(c => c.type === 'image')!.data, 'base64'));
            return { color: [...png.data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)], ...JSON.parse(content.find(c => c.type === 'text')!.text) };
        };
        expect((await preview(draft.draft_id)).color).toEqual([255, 0, 0, 255]);
        writeFileSync(path.join(directory, 'color.txt'), 'lime');
        // Observe the app-owned mirror, not a pull that would refresh the source.
        await expect.poll(() => readFileSync(path.join(userData, 'data', 'motifs', 'drafts', draft.draft_id, 'color.txt'), 'utf8'), { timeout: 10000 }).toBe('lime');
        const green = await preview(draft.draft_id);
        expect(green.color).toEqual([0, 255, 0, 255]);
        expect(green.revision).not.toBe(draft.revision);
        const stale = await client.callTool({ name: 'update_motif_files', arguments: { draft_id: draft.draft_id, expected_revision: draft.revision, files: [{ path: 'color.txt', text: 'black' }] } });
        expect(stale.isError).toBe(true);
        const bytes = Buffer.from('blue'), upload = await call('begin_file_upload', { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        await call('write_file_chunk', { file_id: upload.file_id, offset: 0, base64: bytes.toString('base64') });
        const edited = await call('update_motif_files', { draft_id: draft.draft_id, expected_revision: green.revision, files: [{ path: 'color.txt', file_id: upload.file_id }] });
        expect(readFileSync(path.join(directory, 'color.txt'), 'utf8')).toBe('blue');
        const file = await call('read_motif', { id: draft.draft_id, path: 'color.txt' });
        expect((await call('read_file_transfer', { file_id: file.file_id })).base64).toBe(bytes.toString('base64'));
        expect((await preview(draft.draft_id)).color).toEqual([0, 0, 255, 255]);
        const published = await call('install_motif', { draft_id: draft.draft_id, expected_revision: edited.revision });
        expect(published.motif_id).not.toBe(draft.draft_id);
        expect(await call('install_motif', { draft_id: draft.draft_id, expected_revision: edited.revision })).toEqual(published);
        const exported = await call('export_motif', { id: published.motif_id });
        const copied = await call('open_motif_draft', { source: { kind: 'zip', file_id: exported.file_id } });
        expect((await preview(copied.draft_id)).color).toEqual([0, 0, 255, 255]);
        writeFileSync(path.join(directory, 'manifest.json'), '{broken');
        expect((await call('read_motif', { id: draft.draft_id })).diagnostic).toBeTruthy();
        expect((await client.callTool({ name: 'preview_motif', arguments: { id: draft.draft_id, t_sec: 0 } })).isError).toBe(true);
        expect((await preview(published.motif_id)).color).toEqual([0, 0, 255, 255]);
        await call('delete_motif', { id: draft.draft_id });
        expect(readFileSync(path.join(directory, 'color.txt'), 'utf8')).toBe('blue');
    }
    finally {
        await client.close();
        await app.close();
    }
});
