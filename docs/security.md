# Security

WeftCut is a local-first desktop app. Every window runs with `contextIsolation`,
`sandbox`, `nodeIntegration: false` and `webSecurity` on. This doc records the
Content-Security-Policy posture: two CSPs for two trust contexts, and the
invariants that must hold when the app is extended.

## The app renderer

The editor UI is first-party code that loads no remote content. Its CSP
(`CSP` in `apps/desktop/electron.vite.config.ts`) is injected as a `<meta>` into
the packaged HTML at build time only; the dev server is untouched because HMR
needs inline, eval and websockets.

- `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`.
- `frame-src motif:` only. The one framed document is a Motif's `params.html`,
  framed with `sandbox="allow-scripts"` and no `allow-same-origin`. `'self'` is
  absent so the app bundle cannot frame itself. The grant widens what may be
  framed, not what the framed page may reach (the `motif:` CSP below).
- `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:`. WASM (eval leaf,
  mediabunny) needs `wasm-unsafe-eval`. `'unsafe-eval'` is for PixiJS's
  `new Function` shader/uniform codegen: the no-eval `pixi.js/unsafe-eval`
  polyfill renders every filtered object empty on WebGPU, which breaks per-layer
  effects in the WebGPU-preferring preview and export. Do not import that
  polyfill (`renderer/main.tsx`). The renderer still loads no remote or inline
  `<script>`, so the XSS vector stays closed.
- `img-/media-/connect-src` include `blob:`/`data:` and the app's own schemes
  (`weftcut-media:` everywhere, `motif:` for images and fetches): the renderer is
  the trusted shell, the opposite of a Motif document.

`screen-pick.html` uses the same packaged CSP with its own sandbox preload
(`preload/screenPick.ts`), not the editor's `window.api`. It reads only its own
session's frozen screenshot and reports ready/hover/finish; main validates the
owning WebContents and main frame. Captures are never persisted.

## Motif documents

A Motif is untrusted, user- or agent-authored web content that the app runs to
capture frames ([motifs.md](motifs.md)). Two orthogonal axes bound it:

- **Process isolation.** The offscreen capture window (`main/motif/capture.ts`)
  is sandboxed, context-isolated, without Node and with **no preload**, so no
  IPC bridge exists. This bounds what a Motif can do to the host.
- **Content confinement.** Every render document is served by the `motif:`
  scheme (`MOTIF_CSP` in `main/motif/protocol.ts`):

  ```
  default-src 'none'; script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline' 'self'; connect-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:
  ```

  `'self'` is the page's own `motif://<id>` origin: local modules, styles,
  models, textures, fonts, plus data/blob fetches. No HTTP(S), WebSocket,
  `file:`, other Motif origins or editor media schemes. JavaScript eval stays
  denied; the supplied Basis build disables dynamic execution rather than
  widening the grant.

The sandbox does not restrict the network and the CSP does not stop a renderer
exploit reaching the OS, so both axes are load-bearing.

Serving rules: the file resolver (`main/motif/packageFiles.ts`) rejects
traversal and symbolic links, and never serves the private `target` draft
metadata. Responses carry `Cache-Control: no-store`; captures pin user packages
under `/.revisions/<hash>/`. Linked author directories are copied into validated
app-owned snapshots and never become protocol roots. Temporary uploads
(`main/motif/transfers.ts`) are capped at 256 MiB, SHA-256-checked, quota-bound
and expire; their ids are UUIDs, not paths.

Decoder Workers may be created only during `setup()`, at most 8 live, and are
retired after it (`renderer/render/motifs/runtime.ts`); `SharedWorker` is
refused. Setup has a 30 s deadline, frame/CDP operations 5 s. The worker cap is
a lifecycle contract, not an isolation boundary; worker clocks are not
virtualized (ADR 0093).

A Motif's **parameter page** has its own policy (`MOTIF_PARAMS_CSP`):
`default-src 'none'; script-src 'unsafe-inline' motif:; style-src 'unsafe-inline' motif:; img-src data: motif:; font-src data: motif:`.
No `connect-src`, so it cannot fetch anything, data/blob included. It uses
`motif:` rather than `'self'` because its sandboxed origin is opaque.

`script-src 'unsafe-inline'` is deliberate: a Motif is untrusted code we run on
purpose, so there is no trusted-vs-injected boundary for nonces or hashes to
enforce. The CSP's value for Motifs is entirely its egress and remote-load
directives.

### Invariant: widen what a Motif may display, never where it may connect

Never add `https:` or `*` to a Motif CSP directive. Project media reaches a
Motif through `media` props (ADR 0132): before setup, `main/motif/mediaProps.ts`
resolves each prop to `motif://<id>/.media/<picture key>` (key = content hash,
plus frame time for video) and the protocol serves only pictures a resolve
registered. The page loads them as its own files, so the render CSP is
unchanged. Any new media capability follows the same pattern.
