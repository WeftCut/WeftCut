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
const descriptions: Record<string, string> = { motif_id: 'Motif id (list_motifs).', status: 'Filter by lifecycle status.', source: 'Exactly one source variant.', kind: 'Source type.', path: 'Path relative to the Motif root.', name: "Display name; the draft's first publication takes its id from it.", expected_revision: 'Revision returned by open, read or preview.', files: 'Atomic batch of file changes.', text: 'Complete UTF-8 file contents.', delete: 'Remove this file.', edits: 'Replacements applied in order to the current UTF-8 file.', old: 'Exact text to replace; must occur exactly once in the file.', new: 'Replacement text.', local_t_s: "1–24 times, in seconds from the Motif's start (its frame(t) time), not timeline time.", props: 'Instance values; missing keys use defaults.', width: 'Maximum frame width in pixels (default 640); the whole canvas is scaled to fit.', height: 'Maximum frame height in pixels; the whole canvas is scaled to fit.', target_id: 'Installed Motif to replace.', expected_version: 'Current version of the publication target.', base64: 'Canonical base64 of the whole file, at most 256 KiB decoded.' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { description: descriptions[key], ...(value as object) }])), required });
const localPath = { ...str, description: 'Absolute path on the app machine.' };
const def = (name: string, annotations: ToolAnnotations, description: string, inputSchema: Record<string, unknown>): MotifToolDef => ({ name, annotations, description, inputSchema });
export const MOTIF_TOOL_DEFS: ReadonlyArray<MotifToolDef> = [
    def('list_motifs', ANN_READ, 'List built-in, installed and draft Motifs with props schemas, revisions and diagnostics. A draft with a proposal carries publication {state: awaiting_approval|approved|rejected, note?, version?, rebound?}.', object({ status: { type: 'string', enum: ['builtin', 'installed', 'draft'] } })),
    def('open_motif_draft', ANN_WRITE, 'Open a draft; returns {motif_id, revision}. directory: a live linked folder (reopening returns its draft). motif: a draft id resumes that draft, any other id copies it. copy: an independent copy of any Motif, drafts included. Copies answer source {id, version}. empty: 960×540, 5 s, no props.', object({ source: { type: 'object', oneOf: [
                object({ kind: { const: 'directory' }, path: { ...str, description: 'Absolute package directory on the app machine.' } }, ['kind', 'path']),
                object({ kind: { const: 'zip' }, path: localPath }, ['kind', 'path']),
                object({ kind: { const: 'motif' }, motif_id: str }, ['kind', 'motif_id']),
                object({ kind: { const: 'copy' }, motif_id: str }, ['kind', 'motif_id']),
                object({ kind: { const: 'empty' }, name: str }, ['kind']),
            ] } }, ['source'])),
    def('read_motif', ANN_READ, 'Read manifest, revision and file inventory. With path: a UTF-8 file returns its text (max 256 KiB); a binary file returns only {size, sha256}. Includes working-directory diagnostics.', object({ motif_id: str, path: str }, ['motif_id'])),
    def('update_motif_files', ANN_DESTRUCTIVE, 'Batch edit draft files; requires current expected_revision. Each entry replaces a file with text or base64 bytes (at most 4 MiB decoded per call), applies exact-match edits to an existing text file, or deletes a path. Prefer edits over resending a whole file. The whole package must remain valid. Linked drafts write through to their directory.', object({ motif_id: str, expected_revision: str, files: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'object', oneOf: [
                    object({ path: str, text: str }, ['path', 'text']), object({ path: str, base64: str }, ['path', 'base64']), object({ path: str, edits: { type: 'array', minItems: 1, items: object({ old: { ...str, minLength: 1 }, new: str }, ['old', 'new']) } }, ['path', 'edits']), object({ path: str, delete: { const: true } }, ['path', 'delete']),
                ] } } }, ['motif_id', 'expected_revision', 'files'])),
    def('preview_motif', ANN_READ, "Render a Motif at each local_t_s as one labelled PNG contact sheet (frames keep their alpha), plus the exact revision and the canvas and frame sizes. Each frame is the whole canvas scaled to fit, never cropped. Refreshes this draft's linked files first; refuses an invalid directory or a stale expected_revision.", object({ motif_id: str, local_t_s: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'number', minimum: 0 } }, props: { type: 'object' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, expected_revision: str }, ['motif_id', 'local_t_s'])),
    def('install_motif', ANN_WRITE, "Propose publishing a draft's expected_revision; the library is untouched until the user approves it in WeftCut's Motif panel. Answers {state: awaiting_approval, proposal_id, target: {id, version} | {new_id}}: tell the user to review it, do not poll. list_motifs shows the outcome. A new proposal from the draft supersedes the old. A new id is the name's; a taken one is refused (MotifIdTaken). To replace an installed Motif pass target_id and expected_version.", object({ motif_id: str, expected_revision: str, target_id: str, expected_version: { type: 'integer', minimum: 1 } }, ['motif_id', 'expected_revision'])),
    def('export_motif', ANN_DESTRUCTIVE, 'Write a complete ZIP snapshot to path: an absolute app-machine .zip in an existing folder; an existing file is refused, never overwritten. Refuses invalid linked content.', object({ motif_id: str, expected_revision: str, path: localPath }, ['motif_id', 'path'])),
    def('delete_motif', ANN_DESTRUCTIVE, 'Delete a user Motif or draft (and its pending proposal); linked source directories are never deleted. Built-ins are refused. Referencing layers become missing-content placeholders.', object({ motif_id: str }, ['motif_id'])),
];
export const MOTIF_RESOURCE_DEFS: ReadonlyArray<MotifResourceDef> = [{ uri: 'motifs://current', name: 'Motif catalog', description: 'Built-in, installed and draft Motifs, without HTML.', mimeType: 'application/json' }];
