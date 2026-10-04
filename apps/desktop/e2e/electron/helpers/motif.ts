import type { Page } from '@playwright/test';
export async function createMotifDraft(page: Page, manifest: Record<string, unknown>, html: string): Promise<string> {
    return page.evaluate(async ({ manifest, html }) => {
        const invoke = (window as any).api.backend.invoke;
        const draft = await invoke('open_motif_draft', { source: { kind: 'empty', name: manifest.name } });
        await invoke('update_motif_files', { draft_id: draft.draft_id, expected_revision: draft.revision, files: [{ path: 'manifest.json', text: JSON.stringify(manifest) }, { path: 'index.html', text: html }] });
        return draft.draft_id;
    }, { manifest, html });
}
export async function publishMotifDraft(page: Page, draftId: string): Promise<string> {
    return page.evaluate(async (draft_id) => {
        const invoke = (window as any).api.backend.invoke;
        const info = await invoke('read_motif', { id: draft_id });
        return (await invoke('install_motif', { draft_id, expected_revision: info.revision })).motif_id;
    }, draftId);
}
