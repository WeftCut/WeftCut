// apps/desktop/src/main/motif/motifTools.ts
//
// Host-level Motif tool dispatcher. Both surfaces call this: the renderer IPC
// path (ts-actor-host.handleInvoke `case 'motif'`) and the MCP path (server.ts
// `route === 'motif'`). Returns a RAW value (array | object | id string | null);
// the MCP caller wraps it via shapeMotifMcpResult, the renderer returns it as-is.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { encodeMotifZip } from './archive';
import type { MotifRebindEntry } from '../state/model';
import type { UserMotifStore } from './store';
import { type BuiltinMotif, type MotifLayerRef, motifSourceFiles } from './authoring';
import { MotifWorkspace, type DraftSource, type FileChange } from './workspace';
import { revisionConflict } from './refusal';
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
    /** Tell connected agents the catalog changed (MCP resources list_changed):
     *  a publication was proposed, approved or rejected. */
    notifyAgents?: () => void;
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
/** read_motif's text bound; a larger text file is refused, not truncated. */
const TEXT_READ_BYTES = 256 * 1024;
/** The subject Motif of a call: one input name on every tool (`motif_id`). */
function subject(a: Record<string, unknown>): string {
    if (typeof a.motif_id !== 'string' || !a.motif_id)
        throw new Error('motif_id is required: the id list_motifs reports');
    return a.motif_id;
}
export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps): unknown {
    const a = rawArgs;
    const workspace = new MotifWorkspace(deps.store, deps.builtins);
    const changed = () => { deps.emitChanged(); deps.refreshCatalog(); };
    // A publication's state moved: the renderer's card and every agent's catalog.
    const transitioned = () => { changed(); deps.notifyAgents?.(); };
    switch (name) {
        case 'list_motifs': return workspace.list(a.status as string | undefined);
        case 'read_motif': {
            if ('encoding' in a)
                throw new Error('read_motif takes no encoding: a path answers its UTF-8 text, or {size, sha256} for a binary file');
            const id = subject(a);
            const info = workspace.read(id);
            if (a.path === undefined) {
                const { html: _html, ...overview } = info;
                return overview;
            }
            const file = motifSourceFiles(deps.store, deps.builtins, id).find(f => f.path === a.path);
            const bytes = file?.bytes ?? (a.path === 'index.html' ? Buffer.from(info.html) : null);
            if (!bytes)
                throw new Error('Unknown Motif file: ' + a.path);
            if (!isUtf8(bytes))
                return { motif_id: id, revision: info.revision, path: a.path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
            if (bytes.length > TEXT_READ_BYTES)
                throw new Error(`${a.path as string} is ${Math.ceil(bytes.length / 1024)} KiB of text, over read_motif's 256 KiB; change it with update_motif_files edits, or read it in the draft's linked directory`);
            return { motif_id: id, manifest: info.manifest, revision: info.revision, path: a.path, text: bytes.toString('utf8') };
        }
        case 'open_motif_draft': {
            const opened = workspace.open(a.source as DraftSource);
            changed();
            return opened;
        }
        case 'update_motif_files': {
            const updated = workspace.update(subject(a), a.expected_revision as string, a.files as FileChange[]);
            changed();
            return updated;
        }
        case 'export_motif': {
            const id = subject(a);
            const info = workspace.read(id);
            if (info.diagnostic)
                throw new Error(info.diagnostic);
            if (a.expected_revision !== undefined && a.expected_revision !== info.revision)
                throw revisionConflict(info.revision, 'export it without expected_revision, or read it again');
            const files = motifSourceFiles(deps.store, deps.builtins, id);
            const bytes = Buffer.from(encodeMotifZip(id, [{ path: 'index.html', bytes: Buffer.from(info.html) }, ...files.filter(f => f.path !== 'index.html')]));
            if (typeof a.path !== 'string' || !path.isAbsolute(a.path))
                throw new Error('export_motif needs path: an absolute app-machine .zip path in an existing folder');
            if (path.extname(a.path).toLowerCase() !== '.zip')
                throw new Error(`export_motif writes a ZIP: path must end in .zip, got ${a.path}`);
            // `wx`: never over an existing file (the same policy as
            // start_export's on_conflict: fail), and a missing parent folder
            // is ENOENT, not a folder made on the caller's behalf.
            writeFileSync(a.path, bytes, { flag: 'wx' });
            return { motif_id: id, revision: info.revision, path: a.path };
        }
        case 'delete_motif': {
            const id = subject(a);
            workspace.delete(id);
            transitioned();
            return { motif_id: id };
        }
        case 'install_motif': {
            // An agent proposes; the user approves in the Motif panel (ADR 0046).
            const proposed = workspace.propose(subject(a), a.expected_revision as string, a.target_id as string | undefined, a.expected_version as number | undefined);
            if (proposed.state === 'awaiting_approval')
                transitioned();
            return proposed;
        }
        // ── Renderer-only channels (router MOTIF_CHANNELS, never MOTIF_TOOLS) ──
        case 'publish_motif': {
            // The app's own Install / Update / Save as new: the user publishes.
            const { updates, ...result } = workspace.publish(subject(a), a.expected_revision as string, a.target_id as string | undefined, a.expected_version as number | undefined, deps.motifLayers());
            if (updates.length)
                deps.dispatchRebind(updates);
            transitioned();
            return result;
        }
        case 'list_motif_proposals': return workspace.proposals(deps.motifLayers());
        case 'approve_motif_proposal': {
            const { updates, ...result } = workspace.approve(subject(a), a.proposal_id as string, deps.motifLayers());
            if (updates.length)
                deps.dispatchRebind(updates);
            transitioned();
            return result;
        }
        case 'reject_motif_proposal': {
            const rejected = workspace.reject(subject(a), a.proposal_id as string, a.note as string | undefined);
            transitioned();
            return rejected;
        }
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
