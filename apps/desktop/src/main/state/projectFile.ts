// The disk form of project.json: what a save writes and what an open turns
// back into the runtime project. The runtime wire (`serializeProject`) is
// what Rust jobs, export and project://compiled read; this file drops from it
// what only one machine and one folder can know.
import type { DecodeRoute } from '../../shared/decode-route'
import type { MediaItem, Project } from './model'
import { serializeProject } from './serialize'
import { toNative, type PathPlatform } from './projectPathNative'

/** Fields of a media item that project.json never holds: the derivative
 *  paths, which the open finds again in the cache. */
const DERIVATIVE_FIELDS = new Set(['conform_path', 'waveform_path', 'thumbnails_dir'])

/** A media item as project.json holds it: `path_abs` only for a file
 *  outside the folder, the route as its tag alone. */
export type MediaItemFile = Omit<MediaItem, 'path_abs' | 'decode_route' | 'conform_path' | 'waveform_path' | 'thumbnails_dir'>
  & { path_abs?: string; decode_route: { route: DecodeRoute['route'] } }

/** `p` in its disk form. Key order follows the runtime object, so an open
 *  followed by a save writes the same bytes. */
export function toProjectFile(p: Project): unknown {
  const wire = serializeProject(p) as Record<string, unknown> & { media_pool: Record<string, MediaItem> }
  const media_pool: Record<string, MediaItemFile> = {}
  for (const [id, item] of Object.entries(wire.media_pool)) media_pool[id] = mediaItemFile(item)
  return { ...wire, media_pool }
}

function mediaItemFile(item: MediaItem): MediaItemFile {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (DERIVATIVE_FIELDS.has(key)) continue
    if (key === 'path_abs' && item.path_rel !== null) continue
    out[key] = key === 'decode_route' ? { route: item.decode_route.route } : value
  }
  return out as MediaItemFile
}

/** The runtime pool of a project folder at `dir`: each item inside the folder
 *  at its native path there, an external one at its recorded path, and no
 *  derivative ready yet. */
export function mediaAtFolder(pool: Record<string, MediaItem | MediaItemFile>, dir: string, platform: PathPlatform): Record<string, MediaItem> {
  const out: Record<string, MediaItem> = {}
  for (const [id, item] of Object.entries(pool)) {
    out[id] = {
      ...item,
      path_abs: item.path_rel !== null ? toNative(dir, item.path_rel, platform) : item.path_abs!,
      decode_route: unreadyRoute(item.decode_route.route),
      conform_path: null, waveform_path: null, thumbnails_dir: null,
    }
  }
  return out
}

function unreadyRoute(route: DecodeRoute['route']): DecodeRoute {
  switch (route) {
    case 'bypass': return { route }
    case 'direct-export': return { route, quick_proxy: null }
    case 'proxied':
    case 'native-sw': return { route, quick_proxy: null, full_proxy: null }
  }
}
