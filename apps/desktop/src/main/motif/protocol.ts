import { protocol } from 'electron'
import { PARAMS_PAGE_FILE } from '../../shared/motifs/catalog.js'
import { resolveMotifFile } from './builtinAssets.js'
import type { UserMotifStore } from './store.js'

/// CSP served with every Motif RENDER document (`index.html` and friends).
/// Render documents load scripts/styles/models from their OWN motif origin,
/// plus embedded data/blob assets. Other Motifs, the network, file: and the
/// editor's privileged schemes remain inaccessible. Local decoder Workers and
/// WASM are allowed; JavaScript eval remains denied.
export const MOTIF_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline' 'self'; connect-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:"

/// CSP served with a Motif's params page. `script-src` and `style-src`
/// allow the `motif:` scheme, so a params page may
/// split itself into companion `.js`/`.css` files instead of cramming
/// everything inline.
///
/// This is separate from the render document's embedded-asset grant:
/// - `default-src 'none'` leaves `connect-src` empty, so fetch / XHR /
///   WebSocket / EventSource are denied. A params page cannot reach the
///   network; unlike a render document it cannot fetch data/blob URLs either.
/// - `'self'` is NOT used for the params page: it is framed with
///   `sandbox="allow-scripts"` and no `allow-same-origin`, so its origin is
///   opaque and `'self'` would match nothing. `motif:` is the only workable
///   way to name a motif's own files.
export const MOTIF_PARAMS_CSP =
  "default-src 'none'; script-src 'unsafe-inline' motif:; style-src 'unsafe-inline' motif:; img-src data: motif:; font-src data: motif:"

/// The CSP for one served motif file. Params pages get the looser script/style
/// sources; every other file — including any HTML the render host loads — keeps
/// the render CSP.
export function cspForMotifFile(rest: string): string {
  return rest === PARAMS_PAGE_FILE ? MOTIF_PARAMS_CSP : MOTIF_CSP
}

/// Exported so index.ts can spread it into the single registerSchemesAsPrivileged call.
/// `standard:true` gives motif://<id>/… real origin semantics (same-origin assets +
/// CSP); `secure:true` lets it host fonts; `supportFetchAPI:true` enables net.fetch.
export const MOTIF_SCHEME_ENTRY = {
  scheme: 'motif',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
} as const

/// Serve motif://<id>/<rest> from TS (built-in assets + the user store). The
/// `?v=<content_hash>` query is ignored by resolution (it only busts the host
/// page cache). Companion files use no-store so an HTML reload after an asset
/// edit cannot pick up an old unversioned JS/model/texture from Chromium's cache.
///
/// With `standard:true`, `motif://countdown/index.html` parses with
/// `hostname === 'countdown'` and `pathname === '/index.html'`.
export function registerMotifProtocol(builtinDir: string, store: UserMotifStore): void {
  protocol.handle('motif', async (request) => {
    const url = new URL(request.url) // motif://<id>/<rest>
    const id = url.hostname
    let rest: string
    try { rest = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html' }
    catch { return new Response('invalid path', { status: 400 }) }
    const file = resolveMotifFile(builtinDir, store, id, rest)
    if (!file) return new Response('not found: ' + id + '/' + rest, { status: 404 })
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Security-Policy': cspForMotifFile(rest),
        'Cache-Control': 'no-store',
      },
    })
  })
}
