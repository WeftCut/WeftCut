// The colour a WebCodecs decode is configured with: the decode target's own
// container tag, then the source's resolved colour (`resolveSourceColor`).
// ADR 0014; layer order in docs/conformance.md § Decode color tags.
import type { SourceColor } from "./ffprobeColorSpace";

/// Return `config` with every `colorSpace` field set. Per field, mediabunny's
/// tag wins: it comes from the decode target's container `colr` atom (mediabunny
/// never parses the bitstream SPS VUI), so a self-describing proxy or a
/// bt2020-tagged original keeps what it declares. A field it omits comes from
/// `sourceColor`, which is complete.
///
/// LANDMINE: the WebCodecs decoder follows this config over the bitstream VUI
/// (verified in Chromium/Electron), so leaving a field unset lets the decoder
/// pick an implementation-defined matrix that disagrees with the other lanes.
/// Whether a WebCodecs decode of this source must run in software to show the
/// resolved colour.
///
/// LANDMINE: a hardware decoder's frames convert by what the bitstream
/// declares, and as BT.709 when it declares nothing, whatever the config's
/// `colorSpace` says (observed: macOS VideoToolbox in Electron 44, an untagged
/// 720x480 H.264 chart previews and exports with BT.709 colours under a
/// smpte170m config; Windows' D3D11 decoder was measured to follow the
/// config). A software decoder's frames follow the config. So a
/// source whose matrix is the rule's and is not BT.709 decodes in software;
/// it is an SD picture by the rule, where that costs little.
export function decodesInSoftwareForColour(sourceColor: SourceColor): boolean {
  return sourceColor.matrixAssumed && sourceColor.matrix !== "bt709";
}

export function withDefaultColorSpace(
  config: VideoDecoderConfig,
  sourceColor: SourceColor,
): VideoDecoderConfig {
  const cs = config.colorSpace;
  return {
    ...config,
    colorSpace: {
      primaries: cs?.primaries ?? sourceColor.primaries,
      transfer: cs?.transfer ?? sourceColor.transfer,
      matrix: cs?.matrix ?? sourceColor.matrix,
      fullRange: cs?.fullRange ?? sourceColor.fullRange,
    },
  };
}
