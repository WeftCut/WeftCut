# Offline 3D model Motifs

The app supports local glTF/GLB, Draco geometry and KTX2/Basis textures. Start
with the official `templates/three-model.zip` beside the installed WeftCut
skill. It contains a working demo, Three.js 0.186.1, bundled loaders and local
decoder JS/WASM. Import it with **Import Motif**, or call
`open_motif_draft { "source": { "kind": "zip", "path": "<absolute path to three-model.zip>" } }` over MCP.
The result includes `{ "draft_id": "...", "revision": "..." }`; importing does not publish or place it.
Preview the draft, then place it with `add_motif_layer` as needed.

## Use your own model

Unzip the template, put the model and all companion buffers/textures under
`assets/`, and change the `model` default in `manifest.json` to its relative
URL, for example `./assets/model.glb`. Preserve relative texture and buffer
paths inside glTF files. ZIP the contents again and import. No conversion to
uncompressed geometry is required. Keep the model's license and attribution
with the package; runtime compatibility does not grant redistribution rights.

From a source checkout, the builder copies the entire asset directory and
bundles the pinned dependencies:

```sh
npm --workspace apps/desktop run motif:three -- ./model.zip /absolute/path/to/assets model.glb
```

The output path is relative to `apps/desktop`; it must not already exist.
Omit the asset directory and model arguments to generate the demo. The builder
rejects escaping paths, symlinks and packages exceeding the import limits.
Normal builds use local dependencies and checked-in decoder bytes; no CDN,
Docker or runtime downloads are required.

## Loader and animation contract

- Await all model/texture decoding in `setup`. Initialization has a 30-second
  wall-clock budget; each subsequent frame/CDP operation has a 5-second budget.
  A timeout destroys the capture host so later captures can recover.
- Dedicated local-file and Blob Workers and WASM compilation are available.
  The runtime manages at most eight live Workers during setup and terminates
  them when setup succeeds or fails. The template uses two workers per decoder
  and explicitly disposes its decoder loaders. Create fresh decoder loaders
  when props rebuild the scene; do not retain a terminated worker pool.
- Worker clocks are not virtualized. Workers are for initialization, not
  autonomous animation. `frame(t)` must synchronously derive visible state
  from absolute `t`. The template uses absolute model rotation and mixer time,
  and disposes old model GPU resources when rebuilding.
- Local modules and decoders must remain in the package. Networking, cross-Motif
  access, Node APIs, ordinary JavaScript `eval`/`new Function`, and SharedWorker
  usage are unavailable. Parameter pages retain their stricter policy.
- Use the supplied Basis pair. The upstream Three.js Basis build can require
  `new Function`; merely enabling WASM does not make that build compatible.
  Our pinned Basis build uses Emscripten `-sDYNAMIC_EXECUTION=0`. Do not replace
  only one of its JS/WASM files or enable `unsafe-eval` to work around this.

The template wires MeshoptDecoder too, but the real compressed-asset regression
suite currently covers Draco, ETC1S and UASTC. An arbitrary glTF extension or
another engine is not automatically supported. KTX2 selects GPU-dependent
texture formats; seek/repeat determinism is tested within the same environment,
not as a bit-identical promise across GPUs or operating systems.

## Maintenance and validation

The template source is `apps/desktop/motif-templates/three-model/`; the builder
is `apps/desktop/scripts/build-three-motif.mjs`. `build:skills` includes the ZIP
in the application and packaging checks reject a missing template.
`vendor/basis/BUILD.json` records source/compiler pins, flags and SHA-256 hashes.
To deliberately regenerate the vendored transcoder (Docker and network needed):

```sh
node apps/desktop/scripts/build-basis-transcoder.mjs
```

Review the generated files together and run the builder tests plus
`e2e/electron/motif-codecs.spec.ts`. That suite uses actual compressed assets,
tests MCP ZIP import, pixel output, backward seeks, prop rebuilds, worker
retirement, bad-resource recovery, worker confinement and encoded video frames.
