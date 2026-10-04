// apps/desktop/src/main/motif/motifTools.ts
//
// Host-level Motif tool dispatcher. Both surfaces call this: the renderer IPC
// path (ts-actor-host.handleInvoke `case 'motif'`) and the MCP path (server.ts
// `route === 'motif'`). Returns a RAW value (array | object | id string | null);
// the MCP caller wraps it via shapeMotifMcpResult, the renderer returns it as-is.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeMotifZip, decodeMotifZip } from './archive';
import type { MotifRebindEntry } from '../state/model';
import type { UserMotifStore } from './store';
import { type BuiltinMotif, type MotifLayerRef, motifSourceFiles } from './authoring';
import { MotifWorkspace, type DraftSource, type FileChange } from './workspace';
import { FileTransfers } from './transfers';
import { type MotifStaleEntry, currentVersions, buildStalenessReport, buildAckEntries } from './staleness';
export interface MotifToolDeps {
    store: UserMotifStore;
    builtins: BuiltinMotif[];
    /** Motif layers from the live actor snapshot (install Update rebind input). */
    motifLayers: () => MotifLayerRef[];
    /** Apply rebind_motif through the actor; throws on a rejected write. */
    dispatchRebind: (updates: MotifRebindEntry[]) => void;
    /** Emit `motifs:changed` to the renderer (picker re-pull + host buster). */
    emitChanged: () => void;
    /** Re-pull list_motifs → actor.setUserMotifManifests (content-window clamp). */
    refreshCatalog: () => void;
    /** Emit a record-panel LogBus warn row (the on-open staleness summary).
     *  Best-effort; the host wraps the underlying emit in try/catch. */
    emitLog: (entry: {
        level: 'warn';
        category: {
            kind: 'Project';
        };
        source: {
            kind: 'System';
        };
        message: string;
    }) => void;
}
export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps): unknown {
    const a = rawArgs;
    const workspace = new MotifWorkspace(deps.store, deps.builtins);
    const transfers = new FileTransfers(path.join(deps.store.root(), '.transfers'));
    const changed = () => { deps.emitChanged(); deps.refreshCatalog(); };
    switch (name) {
        case 'list_motifs': return workspace.list(a.status as string | undefined);
        case 'read_motif': {
            const info = workspace.read(a.id as string);
            if (a.path === undefined) {
                const { html: _html, ...overview } = info;
                return overview;
            }
            const file = motifSourceFiles(deps.store, deps.builtins, a.id as string).find(f => f.path === a.path);
            const bytes = file?.bytes ?? (a.path === 'index.html' ? Buffer.from(info.html) : null);
            if (!bytes)
                throw new Error('Unknown Motif file: ' + a.path);
            if (a.encoding === 'text') {
                if (bytes.length > 256 * 1024)
                    throw new Error('Text exceeds 256 KiB; request a file transfer');
                return { id: a.id, manifest: info.manifest, revision: info.revision, path: a.path, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
            }
            return { id: a.id, revision: info.revision, path: a.path, ...transfers.put(bytes) };
        }
        case 'open_motif_draft': {
            const source = a.source as DraftSource | {
                kind: 'zip';
                file_id: string;
            };
            if (!source || typeof source !== 'object')
                throw new Error('A draft source is required');
            if ('file_id' in source && Object.keys(source).some(k => k !== 'kind' && k !== 'file_id'))
                throw new Error('ZIP source needs exactly one path or file_id');
            const opened = source.kind === 'zip' && 'file_id' in source ? workspace.openFiles(decodeMotifZip(transfers.bytes(source.file_id))) : workspace.open(source as DraftSource);
            changed();
            return opened;
        }
        case 'update_motif_files': {
            const updated = workspace.update(a.draft_id as string, a.expected_revision as string, a.files as FileChange[], id => transfers.bytes(id));
            changed();
            return updated;
        }
        case 'export_motif': {
            const info = workspace.read(a.id as string);
            if (info.diagnostic)
                throw new Error(info.diagnostic);
            if (a.expected_revision !== undefined && a.expected_revision !== info.revision)
                throw new Error('Motif revision conflict');
            const files = motifSourceFiles(deps.store, deps.builtins, a.id as string);
            const bytes = Buffer.from(encodeMotifZip(a.id as string, [{ path: 'index.html', bytes: Buffer.from(info.html) }, ...files.filter(f => f.path !== 'index.html')]));
            if (a.path !== undefined) {
                if (!path.isAbsolute(a.path as string))
                    throw new Error('Export path must be absolute');
                writeFileSync(a.path as string, bytes);
                return { id: a.id, revision: info.revision, path: a.path };
            }
            return { id: a.id, revision: info.revision, ...transfers.put(bytes) };
        }
        case 'delete_motif':
            workspace.delete(a.id as string);
            changed();
            return { motif_id: a.id };
        case 'install_motif': {
            const { updates, ...result } = workspace.install(a.draft_id as string, a.expected_revision as string, a.target_id as string | undefined, a.expected_version as number | undefined, deps.motifLayers());
            if (updates.length)
                deps.dispatchRebind(updates);
            changed();
            return result;
        }
        case 'begin_file_upload': return transfers.begin(a.size as number, a.sha256 as string);
        case 'write_file_chunk': return transfers.write(a.file_id as string, a.offset as number, a.base64 as string);
        case 'read_file_transfer': return transfers.read(a.file_id as string, a.offset as number | undefined, a.length as number | undefined);
        case 'delete_file_transfer':
            transfers.delete(a.file_id as string);
            return { file_id: a.file_id };
        case 'motif_staleness_report': {
            const current = currentVersions(deps.builtins, deps.store.listManifests());
            const layers = deps.motifLayers().map((l) => ({ motifId: l.motifId, placedVersion: l.version }));
            const report: MotifStaleEntry[] = buildStalenessReport(layers, current);
            if (report.length) {
                const summary = report
                    .map((e) => `${e.motif_id} v${e.placed_version}→v${e.current_version} (${e.layer_count} layer(s))`)
                    .join(', ');
                deps.emitLog({ level: 'warn', category: { kind: 'Project' }, source: { kind: 'System' }, message: `Motifs changed since placement: ${summary}` });
            }
            return report;
        }
        case 'acknowledge_motif_staleness': {
            const current = currentVersions(deps.builtins, deps.store.listManifests());
            const layers = deps.motifLayers().map((l) => ({ layerId: l.layerId, motifId: l.motifId, placedVersion: l.version, props: l.props }));
            const updates = buildAckEntries(layers, current);
            if (updates.length)
                deps.dispatchRebind(updates);
            // Refresh so applyUpdateLayerParams' content-window clamp sees the
            // current manifests. Cheap + idempotent.
            deps.refreshCatalog();
            return updates.length;
        }
        default:
            throw new Error(`runMotifTool: unhandled tool ${name}`);
    }
}
