// apps/desktop/src/main/state/jobs-writeback.ts
//
// Main-process adapter for the Rust jobs derivative write-back. A completed
// background job (proxy / thumbnail / waveform / conform) emits
// `media:derivatives { media_id, patch }` (native/src/jobs/mod.rs
// commit_media_derivatives); the onEvent bridge routes it here. This
// is a thin adapter over the gated `set_media_derivatives` dispatch arm
// (actor.ts) — the patch's proxy fields carry the absent/null/string
// tri-state (`'key' in patch`, mutations/media.ts) the Rust serialize
// preserves. UNRECORDED on the actor (durable across undo; 1 broadcast id).
import type { ActorHandle, DispatchResult } from './actor'
import type { MediaDerivativesPatch } from './mutations/media'
import { parseProjectPath } from '../../shared/projectPath'

export interface MediaDerivativesEvent {
  media_id: string
  patch: MediaDerivativesPatch
}

/** Apply a `media:derivatives` event to the TS actor. Returns the dispatch
 *  result. A `MediaNotFound` is benign (the media may have been removed between
 *  job enqueue and completion) — logged, not thrown, matching the Rust path's
 *  `warn!`-and-continue on a `set_media_derivatives` Err. */
export function applyDerivativesEvent(
  actor: Pick<ActorHandle, 'dispatch'>,
  payload: MediaDerivativesEvent,
): DispatchResult {
  const r = actor.dispatch('set_media_derivatives', { media: payload.media_id, patch: payload.patch })
  if (!r.ok) {
    console.warn(`[jobs-writeback] set_media_derivatives failed for ${payload.media_id}: ${r.error.error}`)
  }
  return r
}

/** `media:workspace_paths` event payload (native/src/jobs/mod.rs
 *  commit_media_workspace_paths): the result of the background workspace-copy
 *  job. Carries the full 5-field WorkspacePaths so the TS actor's
 *  set_media_workspace_paths dispatch is fully populated. */
export interface MediaWorkspacePathsEvent {
  media_id: string
  path_abs: string
  path_rel: string
  file_hash_blake3: string
  file_size: number
  file_mtime: number
}

/** Apply a `media:workspace_paths` event to the TS actor (sibling of
 *  applyDerivativesEvent; the workspace-copy job's path/hash write-back).
 *  The dispatch arg shape is `{ media, paths }` (actor.ts
 *  set_media_workspace_paths arm — `paths` is the 5-field WorkspacePaths).
 *  MediaNotFound is benign (the media may have been removed between import
 *  and copy-completion) — logged, not thrown. Null: a copy of other bytes
 *  than the item records, discarded unapplied. Throws on a `path_rel` that is
 *  not a ProjectPath. */
export function applyWorkspacePathsEvent(
  actor: Pick<ActorHandle, 'dispatch' | 'snapshot'>,
  payload: MediaWorkspacePathsEvent,
  relocated?: (proof: import('../../shared/media-source-relocated').MediaSourceRelocated) => void,
  discard?: (path: string) => void,
): DispatchResult | null {
  const pathRel = parseProjectPath(payload.path_rel)
  const previous = actor.snapshot().media_pool[payload.media_id];
  // A copy is the item's file only if it holds the bytes the item records.
  // The source can be overwritten while its copy waits in the queue; the copy
  // of those other bytes is discarded, and the item keeps its source path,
  // which reads as changed (ADR 0153). Its derivatives, layers and cached
  // answers all name the recorded bytes, so adopting the copy's hash would
  // silently swap what they describe.
  if (previous && !previous.file_hash_blake3.startsWith('pending-') && previous.file_hash_blake3 !== payload.file_hash_blake3) {
    console.warn(`[jobs-writeback] ${payload.media_id}: the source changed before its copy; discarding ${payload.path_abs}`)
    discard?.(payload.path_abs)
    return null
  }
  const r = actor.dispatch('set_media_workspace_paths', {
    media: payload.media_id,
    paths: {
      path_abs: payload.path_abs,
      path_rel: pathRel,
      file_hash_blake3: payload.file_hash_blake3,
      file_size: payload.file_size,
      file_mtime: payload.file_mtime,
    },
  })
  if (!r.ok) {
    console.warn(`[jobs-writeback] set_media_workspace_paths failed for ${payload.media_id}: ${r.error.error}`)
  }
  if (r.ok && previous && previous.file_hash_blake3 === payload.file_hash_blake3 && previous.file_size === payload.file_size) {
    relocated?.({ media_id: payload.media_id, from: previous.path_abs, to: payload.path_abs,
      content_hash: payload.file_hash_blake3, size_bytes: payload.file_size });
  }
  return r
}
