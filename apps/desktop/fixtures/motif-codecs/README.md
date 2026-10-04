# Motif codec fixtures

These small public test assets are committed so codec tests run offline.

- `box.gltf`, `box.bin`: **Box**, © 2017 Cesium, CC BY 4.0
  (<https://creativecommons.org/licenses/by/4.0/legalcode>).
  Unmodified files from Khronos glTF-Sample-Assets commit
  `edc7c9e67c639d230715049ee31f9a96a6babbbe`,
  `Models/Box/glTF-Draco/`. Source and attribution:
  <https://github.com/KhronosGroup/glTF-Sample-Assets/tree/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/Box>.
  Tests add synthetic UVs and an unlit material and pack a GLB in memory.
- `etc1s.ktx2`, `uastc.ktx2`: unmodified `2d_etc1s.ktx2` and
  `2d_uastc.ktx2` from Three.js commit
  `576b084aff43ec5bb79911befb1d51be178cb7ed`, `examples/textures/ktx2/`.
  Three.js is MIT licensed; see `three-LICENSE.txt`.
  <https://github.com/mrdoob/three.js/tree/576b084aff43ec5bb79911befb1d51be178cb7ed/examples/textures/ktx2>.

The GLB requires Draco (no uncompressed fallback). The textures require real
Basis transcoding; tests do not replace the decoders or accept placeholder pixels.
