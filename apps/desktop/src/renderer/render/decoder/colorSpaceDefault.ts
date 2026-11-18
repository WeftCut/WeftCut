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
