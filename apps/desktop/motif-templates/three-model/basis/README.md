# CSP-compatible Basis transcoder

Generated JS/WASM pair; do not edit individually. `BUILD.json` records the
Basis Universal source commit, immutable Emscripten container digest, compiler
flags and SHA-256 hashes. `LICENSE.txt` is the upstream Apache-2.0 license.

Rebuild from the repository root using
`node apps/desktop/scripts/build-basis-transcoder.mjs`. This maintainer command
requires Docker and network; normal template/application builds are offline.
Downloaded and cached source files are checked against Git blob hashes.

`-sDYNAMIC_EXECUTION=0` avoids Emscripten Embind's `new Function` path, allowing
KTX2Loader to work with WASM permission without JavaScript `unsafe-eval`.
Validate changes with the real Electron ETC1S/UASTC codec tests. Background:
https://github.com/mrdoob/three.js/issues/34389
