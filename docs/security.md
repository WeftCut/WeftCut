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
capture frames ([motifs.md](motifs.md)). Three axes bound it:

- **Process isolation.** The offscreen capture window (`main/motif/captureHost.ts`)
  is sandboxed, context-isolated, without Node and with **no preload**, so no
  IPC bridge exists. This bounds what a Motif can do to the host.
- **A session of its own.** Capture windows run in the in-memory `motif-capture`
  partition (`main/motif/captureSession.ts`), apart from the editor's session.
  The browser process cancels every `http:`, `https:`, `ws:`, `wss:` and `file:`
  request there and denies every permission, device, screen-capture request and
  download. Only `motif:` has a handler in it. The webRequest filter names only
  those schemes, so a Motif's own `motif:`, `data:` and `blob:` loads never wait
  on the main process.
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

The CSP and the partition both refuse the network: the CSP in the page, the
partition in the browser process, which a renderer that ignores its CSP cannot
reach. Neither stops a renderer exploit chained with a sandbox escape reaching
the OS; the OS sandbox and a current Electron are what stand there.

**Trust decides whether a project Motif runs at all**
([ADR 0174](adr/0174-a-motif-runs-only-when-trusted-on-this-machine.md)).
A project carries its Motifs' code (ADR 0173), and the sandbox above is not
hardened against a renderer exploit, so a revision this machine has not trusted
never runs: one found when a project opens, or brought in from a ZIP or an
outside folder. The gate is one place, `MotifResolver` (`main/motif/resolver.ts`),
which answers such a project host `untrusted`; the protocol (`params.html`
included), capture hosts, previews, bakes and covers all resolve through it.
The record (`<dataRoot>/motifs/.trust.json`, `main/motif/trust.ts`) is keyed by
revision, never by lineage or project, and the library's revisions are trusted
by derivation. Only the user trusts, on the Motifs panel's trust card, from a
summary read as text without running anything; its channels are renderer-only
and no MCP tool can trust. Trust guards against code arriving in a folder, not
against a local agent writing code: edits made while a project is open, from a
trusted revision, are trusted. Everything a received project folder holds is
its sender's, `project.wcpr`'s Motif table and `Backups/motifs/` included, so
trust is earned only from positive evidence: an edit is judged from the
revision this session itself last observed in the folder, never from the one
the table records, and reads apply that rule alone; a folder whose name was
not under `Motifs/` at the open, and that no backup was put back in, was made
here, unless it holds what a folder found untrusted held (a copy or a move,
recognised under any name). A backup is put back only
when its files make the revision it names, and bytes put back count as found
at an open, never as an edit. A folder is read only under its exact name,
which must be a table key, so a case-insensitive file system cannot read
`Motifs/Evil/` as `evil`. An agent that copies text it read from an untrusted
Motif into a trusted one makes that code trusted: trust protects against code
arriving in folders, not against what a local agent chooses to write.

Serving rules: the file resolver (`main/motif/packageFiles.ts`) rejects
traversal and symbolic links; packages hold no private files (ADR 0171).
A Motif's lineage is a claim a ZIP can make freely, never a reason to trust
its code. Responses carry `Cache-Control: no-store`; captures pin user packages
under `/.revisions/<hash>/` for the life of the host that loads them. Linked author directories are copied into validated
app-owned snapshots and never become protocol roots. Inline file writes
(`update_motif_files` `{path, base64}`) are canonical base64, at most 256 KiB
decoded per file and 4 MiB per call, and pass the same path checks.

Decoder Workers may be created only during `setup()`, at most 8 live, and are
retired after it (`renderer/render/motifs/runtime.ts`); `SharedWorker` is
refused. Setup has a 30 s deadline, frame/CDP operations 5 s. The worker cap is
a lifecycle contract, not an isolation boundary; worker clocks are not
virtualized ([motifs.md](motifs.md#security)).

A Motif's **parameter page** has its own policy (`MOTIF_PARAMS_CSP`):
`default-src 'none'; script-src 'unsafe-inline' motif:; style-src 'unsafe-inline' motif:; img-src data: motif:; font-src data: motif:`.
No `connect-src`, so it cannot fetch anything, data/blob included. It uses
`motif:` rather than `'self'` because its sandboxed origin is opaque. The page
is an iframe in the editor's window, in the default session, but in a renderer
process of its own: site isolation puts `motif://<id>` apart from the editor's
`file://` page, and Chromium isolates sandboxed iframes as well (both on by
default; the app turns neither off). So the editor's preload bridge is not in
its process; it reaches the editor only through the `postMessage` protocol
`renderer/properties/motifParamsHost.ts` checks.

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
