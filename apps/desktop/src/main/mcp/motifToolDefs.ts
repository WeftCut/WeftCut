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
const str = { type: 'string' }, integer = { type: 'integer', minimum: 0 };
const descriptions: Record<string, string> = { id: 'Motif id.', status: 'Filter by lifecycle status.', source: 'Exactly one source variant.', kind: 'Source type.', path: 'Path relative to the Motif root.', name: 'Initial display name.', file_id: 'Temporary file transfer id.', encoding: 'text for UTF-8; file for a download id.', draft_id: 'Editable draft id.', expected_revision: 'Revision returned by open, read or preview.', files: 'Atomic batch of file changes.', text: 'Complete UTF-8 file contents.', delete: 'Remove this file.', t_sec: 'Absolute content time in seconds.', props: 'Instance values; missing keys use defaults.', width: 'Capture width in pixels.', height: 'Capture height in pixels.', target_id: 'Installed Motif to replace.', expected_version: 'Current version of the publication target.', size: 'Total file size in bytes.', sha256: 'Lowercase SHA-256 of the complete file.', offset: 'Zero-based byte offset.', base64: 'Canonical base64 chunk.', length: 'Maximum decoded bytes to read.' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { description: descriptions[key], ...(value as object) }])), required });
const localPath = { ...str, description: 'Absolute path on the app machine.' };
const def = (name: string, annotations: ToolAnnotations, description: string, inputSchema: Record<string, unknown>): MotifToolDef => ({ name, annotations, description, inputSchema });
export const MOTIF_TOOL_DEFS: ReadonlyArray<MotifToolDef> = [
    def('list_motifs', ANN_READ, 'List built-in, installed and draft Motifs with props schemas, revisions and diagnostics.', object({ status: { type: 'string', enum: ['builtin', 'installed', 'draft'] } })),
    def('open_motif_draft', ANN_WRITE, 'Open a directory as a live draft, copy a Motif/ZIP, or start empty. Returns {draft_id,revision}. Directory opens reuse the draft; copies do not select a publication target.', object({ source: { type: 'object', oneOf: [
                object({ kind: { const: 'directory' }, path: { ...str, description: 'Absolute package directory on the app machine.' } }, ['kind', 'path']),
                object({ kind: { const: 'zip' }, path: localPath }, ['kind', 'path']),
                object({ kind: { const: 'zip' }, file_id: str }, ['kind', 'file_id']),
                object({ kind: { const: 'motif' }, id: str }, ['kind', 'id']),
                object({ kind: { const: 'empty' }, name: str }, ['kind']),
            ] } }, ['source'])),
    def('read_motif', ANN_READ, 'Read manifest, revision and file inventory. With path: encoding=text returns UTF-8 (max 256 KiB); otherwise returns a downloadable file_id. Includes working-directory diagnostics.', object({ id: str, path: str, encoding: { type: 'string', enum: ['text', 'file'] } }, ['id'])),
    def('update_motif_files', ANN_DESTRUCTIVE, 'Batch edit draft files; requires current expected_revision. Each entry adds/replaces text or an uploaded file_id, or deletes a path. The whole package must remain valid. Linked drafts write through to their directory.', object({ draft_id: str, expected_revision: str, files: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'object', oneOf: [
                    object({ path: str, text: str }, ['path', 'text']), object({ path: str, file_id: str }, ['path', 'file_id']), object({ path: str, delete: { const: true } }, ['path', 'delete']),
                ] } } }, ['draft_id', 'expected_revision', 'files'])),
    def('preview_motif', ANN_READ, 'Render a Motif frame. Returns PNG plus the exact revision. Refreshes linked files first; refuses invalid directories or a mismatched expected_revision.', object({ id: str, t_sec: { type: 'number' }, props: { type: 'object' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, expected_revision: str }, ['id', 't_sec'])),
    def('install_motif', ANN_DESTRUCTIVE, 'Publish expected_revision and retain the draft. First publish creates a Motif; later publishes update its recorded target. To replace another installed Motif supply target_id and expected_version. Repeating the same publication does not bump its version.', object({ draft_id: str, expected_revision: str, target_id: str, expected_version: { type: 'integer', minimum: 1 } }, ['draft_id', 'expected_revision'])),
    def('export_motif', ANN_WRITE, 'Export a complete ZIP snapshot. Returns file_id for download, or writes an absolute app-machine path when supplied. Refuses invalid linked content.', object({ id: str, expected_revision: str, path: localPath }, ['id'])),
    def('delete_motif', ANN_DESTRUCTIVE, 'Delete a user Motif or draft; linked source directories are never deleted. Built-ins are refused. Referencing layers become missing-content placeholders.', object({ id: str }, ['id'])),
    def('begin_file_upload', ANN_WRITE, 'Reserve a temporary file (max 256 MiB), declaring byte size and SHA-256. Returns file_id and chunk_bytes. Transfers expire after 24 hours; total quota is 512 MiB.', object({ size: { ...integer, maximum: 268435456 }, sha256: { ...str, pattern: '^[0-9a-f]{64}$' } }, ['size', 'sha256'])),
    def('write_file_chunk', ANN_WRITE, 'Append a base64 chunk at byte offset (max 256 KiB decoded). Exact retries are safe. Final chunk verifies SHA-256; only complete files can be attached or imported.', object({ file_id: str, offset: integer, base64: str }, ['file_id', 'offset', 'base64'])),
    def('read_file_transfer', ANN_READ, 'Read a bounded base64 range and transfer status. Returns next_offset, eof, received_bytes and complete; also supports resuming uploads.', object({ file_id: str, offset: integer, length: { type: 'integer', minimum: 1, maximum: 262144 } }, ['file_id'])),
    def('delete_file_transfer', ANN_DESTRUCTIVE, 'Release a temporary transfer. Files already copied into drafts are unaffected.', object({ file_id: str }, ['file_id'])),
];
export const MOTIF_RESOURCE_DEFS: ReadonlyArray<MotifResourceDef> = [{ uri: 'motifs://current', name: 'Motif catalog', description: 'Built-in, installed and draft Motifs, without HTML.', mimeType: 'application/json' }];
