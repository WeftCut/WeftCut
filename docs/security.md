# Security

WeftCut is a local-first desktop app: the renderer loads only the app's own bundled
UI, and every window runs with Electron's isolation defaults hardened on
(`contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`). This document
records the **Content-Security-Policy** posture — why each CSP is shaped the way it is,
and the invariants that must hold when the app is extended. (Window, IPC, and
filesystem hardening live in `src/main/`; this doc focuses on CSP.)

There are two distinct CSPs, for two distinct trust contexts.

## The app renderer

The editor UI is first-party code that loads no remote content. Its CSP is injected
into the packaged `index.html` at build time (`electron.vite.config.ts`); the dev
server is left untouched, because HMR needs inline + eval + websockets.

- `default-src 'self'`, `object-src 'none'`, `base-uri 'self'` — no `<base>` hijack, no
  plugins.
- **`frame-src motif:`** — the only embeddable context is a Motif's own parameter page
  (see [`motifs.md`](motifs.md)), framed by the property panel with
  `sandbox="allow-scripts"` and no `allow-same-origin`. `'self'` is deliberately absent:
  the renderer frames none of its own documents, so the app bundle stays unembeddable in
  itself. The grant widens what may be *framed*; what the framed page may *reach* is
  still bounded by the `motif:` CSP below.
- `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:`. WASM (the eval leaf,
  mediabunny) needs the narrow `wasm-unsafe-eval` compile grant. `'unsafe-eval'` is
  granted for PixiJS's `new Function` shader/uniform codegen: the no-eval
  `pixi.js/unsafe-eval` polyfill we previously used to *avoid* this grant renders
  every **filtered** object EMPTY on the **WebGPU** backend (filters work on WebGL
  either way), which kills the per-layer effects subsystem in the WebGPU-preferring
  preview and export. Real codegen + `'unsafe-eval'` is the accepted trade. The grant
  widens the eval surface but not the *content* surface — the renderer still loads no
  remote or inline `<script>`, so the practical XSS vector (the thing CSP exists to
  block here) stays closed.
- `img-/media-/connect-src` include the app's own privileged schemes (`weftcut-media:`,
  `motif:`) plus `blob:`/`data:` — the editor legitimately fetches imported media and
  Motif assets.

The renderer is allowed to reach its own privileged schemes because it **is** the
trusted shell. This is the exact opposite of the Motif document context below.

The first-party `screen-pick.html` uses the same packaged CSP but a dedicated
sandbox preload (`preload/screenPick.ts`), not the editor's `window.api`. It can
read only its own session's frozen screenshot and report ready/hover/finish.
Main validates the owning WebContents and main frame for these messages; other
windows cannot read its screenshot or settle its session. Desktop requests are
owned by the invoking editor window and captures are never persisted.

## Motif documents

A Motif is **untrusted, user- or agent-authored web content** that the app executes to
capture animation frames (see [`motifs.md`](motifs.md)). It runs in a dedicated
offscreen capture window, and its security rests on **two orthogonal axes**:

- **Process isolation (the sandbox axis).** The capture host runs at the same hardened
  baseline as every app window — `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, and **no preload** — so a Motif's JavaScript reaches neither
  Node, the OS, nor any IPC bridge (none is exposed to it). This bounds what a Motif can
  *do to the host*.
- **Content confinement (the CSP axis).** Every Motif document is served by the `motif:`
  scheme with:

  ```
  default-src 'none'; script-src 'unsafe-inline' 'self' 'wasm-unsafe-eval'; style-src 'unsafe-inline' 'self'; connect-src 'self' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:
  ```

  `'self'` is the render page's own `motif://<id>` origin. It permits local ES
  modules, styles, models, textures and fonts, plus embedded data/blob fetches and
  images. It grants no HTTP(S), WebSocket, `file:`, other Motif origins or editor
  media schemes. Local/Blob dedicated Workers and WASM support decoder setup;
  ordinary JavaScript eval remains denied. This bounds what a Motif can
  *reach* while remaining offline. The file resolver rejects traversal and
  symbolic links/junctions; private draft metadata (`target`) is not served.
  Responses use `Cache-Control: no-store` so companion URLs cannot outlive an
  asset edit. Render hashes cover companion paths and bytes (ADR 0079).

  Decoder Workers are retired after setup, which has a 30-second budget;
  frame/CDP operations retain 5-second deadlines. The runtime's managed
  eight-worker limit is an authoring/lifecycle contract, not an isolation
  boundary against untrusted JavaScript. Worker clocks are not virtualized.
  The supplied Basis build disables dynamic execution rather than widening
  the eval grant. See ADR 0093 and `motif-three-model.md`.

  A Motif's **parameter page** (`params.html`, the one document the app frames rather
  than captures) retains its separate policy: inline and `motif:` scripts/styles,
  `data:` / `motif:` images/fonts, `default-src 'none'` and no `connect-src`.
  It cannot fetch resources, including data/blob URLs. `'self'` is not used for
  this page, because it is framed
  with `sandbox="allow-scripts"` and no `allow-same-origin`, so its origin is opaque
  and `'self'` would match nothing.

**The two axes are not redundant.** The sandbox does not restrict the network, so a
sandboxed-but-unconfined Motif could still read whatever it can reach and exfiltrate it;
the CSP is what closes that. Conversely, the CSP would not stop a renderer exploit from
reaching the OS; the sandbox does. Both are load-bearing — neither substitutes for the
other.

### Why `script-src 'unsafe-inline'` is deliberate, not a gap

A Motif *is* untrusted author code that we intentionally run — that is the whole feature.
So `script-src`'s usual anti-XSS role is moot here: a wholly-untrusted document has no
trusted-vs-injected boundary to enforce, and a nonce/hash allowlist would add machinery
for no security gain. The CSP's entire security value for Motifs lives in its *other*
directives — the egress and remote-load controls (`default-src 'none'`, connections
limited to the package's own origin and embedded data/blob resources).

### Invariant: keep the egress axis closed

Never add `https:` or `*` to a Motif CSP directive. When Motifs gain the ability to
reference **project media** (a planned feature — the end-user binds an imported photo or
clip to a Motif instance), that capability must be granted through a dedicated,
capability-scoped privileged scheme: the app resolves an instance's bound media to
opaque, per-render URLs the Motif can load, and the handler serves only the media that
instance was granted. It must **never** be granted by loosening `connect-src`/`img-src`
toward the network. The rule: widen *what a Motif may display*, never *where it may
connect*.
