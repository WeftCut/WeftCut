import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PNG } from 'pngjs';
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver';

/** A package whose page paints the colour named in its color.txt. */
function writePackage(directory: string, name: string, color: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ name, size: [64, 64], default_duration_s: 1, props_schema: {} }));
    writeFileSync(path.join(directory, 'index.html'), `<html><body><script>motif.define({async setup(){document.body.style.background=(await(await fetch('./color.txt')).text()).trim()},frame(){}})</script></body></html>`);
    writeFileSync(path.join(directory, 'color.txt'), color);
}

test('MCP project Motifs: folder copies and edits, binary round-trip, revision conflicts and a library proposal the user approves', async () => {
    test.setTimeout(90000);
    const directory = tmpDir('motif-author-directory-');
    writePackage(directory, 'Tinted', 'red');
    const { app, page } = await launchApp();
    const client = new Client({ name: 'e2e-workspace', version: '0' }, { capabilities: {} });
    try {
        await newProject(page, { parentFolder: tmpDir('motif-workspace-project-'), name: 'Workspace', canvas: { width: 64, height: 64, fpsNum: 30, fpsDen: 1 } });
        const info = await page.evaluate(() => (window as any).api.mcp.getInfo());
        await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } } }));
        const names = (await client.listTools()).tools.map(t => t.name);
        for (const old of ['open_motif_draft', 'write_motif_draft', 'amend_motif_draft', 'get_motif_source', 'import_motif', 'preview_motif_draft', 'create_edit_draft', 'begin_file_upload', 'write_file_chunk', 'read_file_transfer', 'delete_file_transfer', 'copy_motif_draft', 'publish_motif', 'approve_motif_proposal', 'reject_motif_proposal', 'motif_staleness_report', 'acknowledge_motif_staleness'])
            expect(names).not.toContain(old);
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            return JSON.parse((result.content as Array<{
                text: string;
            }>)[0].text);
        };
        const preview = async (id: string, group?: 'library') => {
            // One 64-px frame (width 64 keeps it at the canvas size) under the sheet's 26-px label strip.
            const result = await client.callTool({ name: 'preview_motif', arguments: { motif_id: id, local_t_s: [0], width: 64, ...(group ? { group } : {}) } });
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

        // A directory elsewhere is copied into the project's Motifs/.
        const made = await call('create_motif', { source: { kind: 'directory', path: directory } });
        expect(made.motif_id).toBe('tinted');
        expect(path.dirname(made.path)).toBe(path.join(await invokeCmd<string>(page, 'workspace_dir'), 'Motifs'));
        expect((await preview(made.motif_id)).color).toEqual([255, 0, 0, 255]);
        writeFileSync(path.join(directory, 'color.txt'), 'black');
        expect((await preview(made.motif_id)).color, 'the copy does not follow its source folder').toEqual([255, 0, 0, 255]);

        // The agent edits the project's folder with its own file tools.
        writeFileSync(path.join(made.path, 'color.txt'), 'lime');
        await expect.poll(async () => (await preview(made.motif_id)).color, { timeout: 10000 }).toEqual([0, 255, 0, 255]);
        const green = await call('read_motif', { motif_id: made.motif_id });
        expect(green.revision).not.toBe(made.revision);
        const stale = await client.callTool({ name: 'update_motif_files', arguments: { motif_id: made.motif_id, expected_revision: made.revision, files: [{ path: 'color.txt', text: 'black' }] } });
        expect(stale.isError).toBe(true);
        expect(stale.structuredContent).toMatchObject({ error: 'RevisionConflict', current_revision: green.revision });
        const edited = await call('update_motif_files', { motif_id: made.motif_id, expected_revision: green.revision, files: [{ path: 'color.txt', base64: Buffer.from('blue').toString('base64') }] });
        expect(readFileSync(path.join(made.path, 'color.txt'), 'utf8')).toBe('blue');
        expect((await call('read_motif', { motif_id: made.motif_id, path: 'color.txt' })).text).toBe('blue');
        expect((await preview(made.motif_id)).color).toEqual([0, 0, 255, 255]);

        // A folder the agent writes under Motifs/ is adopted where it stands.
        const handMade = path.join(path.dirname(made.path), 'hand-made');
        writePackage(handMade, 'Hand made', 'yellow');
        const adopted = await call('create_motif', { source: { kind: 'directory', path: handMade } });
        expect(adopted).toMatchObject({ motif_id: 'hand-made', path: handMade });
        expect((await preview('hand-made')).color).toEqual([255, 255, 0, 255]);

        // install_motif proposes; the library waits for the user (ADR 0046).
        const proposal = await call('install_motif', { motif_id: made.motif_id, expected_revision: edited.revision });
        expect(proposal).toMatchObject({ state: 'awaiting_approval', target: { new_id: 'tinted' } });
        expect(await call('install_motif', { motif_id: made.motif_id, expected_revision: edited.revision })).toEqual(proposal);
        expect((await call('list_motifs', { group: 'library' })).map((m: { id: string }) => m.id)).not.toContain('tinted');
        // The operator approves as the card's button does (e2e test hook).
        const libraryId = await page.evaluate((motifId) => (window as any).__weftcutTest.motifDecideProposal({ motifId, approve: true }), made.motif_id);
        expect(libraryId).toBe('tinted');
        const row = (await call('list_motifs', { group: 'project' })).find((m: { id: string }) => m.id === made.motif_id);
        expect(row.publication).toMatchObject({ state: 'approved', version: 1 });
        // Approval wrote the library only: the project's folder is as it was.
        expect((await call('read_motif', { motif_id: made.motif_id })).revision).toBe(edited.revision);
        expect((await preview(libraryId, 'library')).color).toEqual([0, 0, 255, 255]);

        // An exported library Motif imports as a copy beside the project's own.
        const zip = path.join(tmpDir('motif-export-'), 'published.zip');
        await call('export_motif', { motif_id: libraryId, group: 'library', path: zip });
        const copied = await call('create_motif', { source: { kind: 'zip', path: zip } });
        expect(copied.motif_id).not.toBe(made.motif_id);
        expect((await preview(copied.motif_id)).color).toEqual([0, 0, 255, 255]);

        // A broken folder is read with its diagnostic and refuses to render;
        // the library's copy is unaffected.
        writeFileSync(path.join(made.path, 'manifest.json'), '{broken');
        expect((await call('read_motif', { motif_id: made.motif_id })).diagnostic).toBeTruthy();
        expect((await client.callTool({ name: 'preview_motif', arguments: { motif_id: made.motif_id, local_t_s: [0] } })).isError).toBe(true);
        expect((await preview(libraryId, 'library')).color).toEqual([0, 0, 255, 255]);

        // Removal takes it out of the project; the folder stays the author's.
        await call('delete_motif', { motif_id: made.motif_id });
        expect((await call('list_motifs', { group: 'project' })).map((m: { id: string }) => m.id)).not.toContain(made.motif_id);
        expect(existsSync(path.join(made.path, 'color.txt'))).toBe(true);
    }
    finally {
        await client.close();
        await app.close();
    }
});
