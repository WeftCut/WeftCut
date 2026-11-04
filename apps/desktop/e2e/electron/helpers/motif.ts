import type { Page } from '@playwright/test';
export async function createMotifDraft(page: Page, manifest: Record<string, unknown>, html: string): Promise<string> {
    return page.evaluate(async ({ manifest, html }) => {
        const invoke = (window as any).api.backend.invoke;
        const draft = await invoke('open_motif_draft', { source: { kind: 'empty', name: manifest.name } });
        await invoke('update_motif_files', { motif_id: draft.motif_id, expected_revision: draft.revision, files: [{ path: 'manifest.json', text: JSON.stringify(manifest) }, { path: 'index.html', text: html }] });
        return draft.motif_id;
    }, { manifest, html });
}
export async function publishMotifDraft(page: Page, draftId: string): Promise<string> {
    // The user's own Install (renderer-only publish_motif); MCP's install_motif only proposes.
    return page.evaluate(async (motif_id) => {
        const invoke = (window as any).api.backend.invoke;
        const info = await invoke('read_motif', { motif_id });
        return (await invoke('publish_motif', { motif_id, expected_revision: info.revision })).motif_id;
    }, draftId);
}
