import { protocol } from 'electron'
import { PARAMS_PAGE_FILE } from '../../shared/motifs/catalog.js'
import { CAPTURE_HOST_FILE, FRAME_MARKER_ROWS } from '../../shared/motifs/frameMarker.js'
import fs from 'node:fs'
import { resolveMotifFile } from './builtinAssets.js'
import { servedMotifMedia } from './mediaProps.js'
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

/// CSP of the capture host page: it frames its own Motif and nothing else. Its
/// only script is the runtime the capture host injects.
export const CAPTURE_HOST_CSP = "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'"

/// The capture host page beside a Motif's `index.html` (same origin, so the
/// runtime can reach into the frame): the Motif at the top-left, sized to the
/// viewport minus the marker rows (shared/motifs/frameMarker.ts). The query
/// goes to the Motif. The frame stays empty until the runtime loads it
/// (`__motifShellLoad`), so the Motif's documents start with the runtime.
export function captureHostPage(search: string): string {
  const rest = new URLSearchParams(search).toString()
  const src = ('index.html' + (rest ? '?' + rest : '')).replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`)
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;padding:0;overflow:hidden;background:transparent}'
    + `iframe{position:fixed;left:0;top:0;width:100vw;height:calc(100vh - ${FRAME_MARKER_ROWS}px);border:0;display:block}`
    + `</style></head><body><iframe data-src="${src}"></iframe></body></html>`
}

/// Exported so index.ts can spread it into the single registerSchemesAsPrivileged call.
/// `standard:true` gives motif://<id>/… real origin semantics (same-origin assets +
/// CSP); `secure:true` lets it host fonts; `supportFetchAPI:true` enables net.fetch.
export const MOTIF_SCHEME_ENTRY = {
  scheme: 'motif',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
} as const

/// Serve motif://<id>/<rest> from TS (built-in assets + the user store). The
/// Captures pin user packages under /.revisions/<hash>/ so relative companion
/// URLs read the same immutable navigation snapshot. The ?v= query also busts
/// the host page cache. Unversioned library/parameter resources use no-store.
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
    // A picture a `media` prop names (./mediaProps.ts), on the Motif's own origin.
    const picture = servedMotifMedia(rest)
    if (picture) {
      try {
        return new Response(new Uint8Array(await fs.promises.readFile(picture.file)), {
          status: 200,
          headers: { 'Content-Type': picture.mime, 'Content-Security-Policy': MOTIF_CSP, 'Cache-Control': 'no-store' },
        })
      } catch { return new Response('not found: ' + id + '/' + rest, { status: 404 }) }
    }
    if (rest.replace(/^\.revisions\/[0-9a-f]{64}\//, '') === CAPTURE_HOST_FILE) {
      return new Response(captureHostPage(url.search), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CAPTURE_HOST_CSP, 'Cache-Control': 'no-store' },
      })
    }
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
