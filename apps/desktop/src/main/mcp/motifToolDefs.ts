import { ANN_DESTRUCTIVE, ANN_READ, ANN_WRITE, type ToolAnnotations } from '../state/mcp-commands.js';
export interface MotifToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: ToolAnnotations;
}
export interface MotifResourceDef {
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
}
const str = { type: 'string' };
const descriptions: Record<string, string> = { id: 'Motif id.', status: 'Filter by lifecycle status.', source: 'Exactly one source variant.', kind: 'Source type.', path: 'Path relative to the Motif root.', name: 'Initial display name.', draft_id: 'Editable draft id.', expected_revision: 'Revision returned by open, read or preview.', files: 'Atomic batch of file changes.', text: 'Complete UTF-8 file contents.', delete: 'Remove this file.', edits: 'Replacements applied in order to the current UTF-8 file.', old: 'Exact text to replace; must occur exactly once in the file.', new: 'Replacement text.', local_t_s: "Seconds from the Motif's start (its frame(t) time).", props: 'Instance values; missing keys use defaults.', width: 'Maximum image width in pixels; the whole frame is scaled to fit.', height: 'Maximum image height in pixels; the whole frame is scaled to fit.', target_id: 'Installed Motif to replace.', expected_version: 'Current version of the publication target.', base64: 'Canonical base64 of the whole file, at most 256 KiB decoded.' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { description: descriptions[key], ...(value as object) }])), required });
const localPath = { ...str, description: 'Absolute path on the app machine.' };
const def = (name: string, annotations: ToolAnnotations, description: string, inputSchema: Record<string, unknown>): MotifToolDef => ({ name, annotations, description, inputSchema });
export const MOTIF_TOOL_DEFS: ReadonlyArray<MotifToolDef> = [
    def('list_motifs', ANN_READ, 'List built-in, installed and draft Motifs with props schemas, revisions and diagnostics.', object({ status: { type: 'string', enum: ['builtin', 'installed', 'draft'] } })),
    def('open_motif_draft', ANN_WRITE, 'Open a directory as a live draft, copy a Motif/ZIP, or start empty. Returns {draft_id,revision}. Directory opens reuse the draft; copies do not select a publication target.', object({ source: { type: 'object', oneOf: [
                object({ kind: { const: 'directory' }, path: { ...str, description: 'Absolute package directory on the app machine.' } }, ['kind', 'path']),
                object({ kind: { const: 'zip' }, path: localPath }, ['kind', 'path']),
                object({ kind: { const: 'motif' }, id: str }, ['kind', 'id']),
                object({ kind: { const: 'empty' }, name: str }, ['kind']),
            ] } }, ['source'])),
    def('read_motif', ANN_READ, 'Read manifest, revision and file inventory. With path: a UTF-8 file returns its text (max 256 KiB); a binary file returns only {size, sha256}. Includes working-directory diagnostics.', object({ id: str, path: str }, ['id'])),
    def('update_motif_files', ANN_DESTRUCTIVE, 'Batch edit draft files; requires current expected_revision. Each entry replaces a file with text or base64 bytes (at most 4 MiB decoded per call), applies exact-match edits to an existing text file, or deletes a path. Prefer edits over resending a whole file. The whole package must remain valid. Linked drafts write through to their directory.', object({ draft_id: str, expected_revision: str, files: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'object', oneOf: [
                    object({ path: str, text: str }, ['path', 'text']), object({ path: str, base64: str }, ['path', 'base64']), object({ path: str, edits: { type: 'array', minItems: 1, items: object({ old: { ...str, minLength: 1 }, new: str }, ['old', 'new']) } }, ['path', 'edits']), object({ path: str, delete: { const: true } }, ['path', 'delete']),
                ] } } }, ['draft_id', 'expected_revision', 'files'])),
    def('preview_motif', ANN_READ, 'Render a Motif frame at its canvas size. Returns PNG plus the exact revision, canvas and image size. width/height bound the image: the whole canvas is scaled to fit, never cropped. Refreshes linked files first; refuses invalid directories or a mismatched expected_revision.', object({ id: str, local_t_s: { type: 'number' }, props: { type: 'object' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, expected_revision: str }, ['id', 'local_t_s'])),
    def('install_motif', ANN_DESTRUCTIVE, 'Publish expected_revision and retain the draft. First publish creates a Motif; later publishes update its recorded target. To replace another installed Motif supply target_id and expected_version. Repeating the same publication does not bump its version.', object({ draft_id: str, expected_revision: str, target_id: str, expected_version: { type: 'integer', minimum: 1 } }, ['draft_id', 'expected_revision'])),
    def('export_motif', ANN_DESTRUCTIVE, 'Write a complete ZIP snapshot to path: an absolute app-machine .zip in an existing folder; an existing file is refused, never overwritten. Refuses invalid linked content.', object({ id: str, expected_revision: str, path: localPath }, ['id', 'path'])),
    def('delete_motif', ANN_DESTRUCTIVE, 'Delete a user Motif or draft; linked source directories are never deleted. Built-ins are refused. Referencing layers become missing-content placeholders.', object({ id: str }, ['id'])),
];
export const MOTIF_RESOURCE_DEFS: ReadonlyArray<MotifResourceDef> = [{ uri: 'motifs://current', name: 'Motif catalog', description: 'Built-in, installed and draft Motifs, without HTML.', mimeType: 'application/json' }];
