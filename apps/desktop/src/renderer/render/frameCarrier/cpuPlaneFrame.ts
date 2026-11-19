// One decoded native frame as the CPU-plane frame the Compositor converts in
// its own shaders, for preview and export alike. What to do with a frame that
// does not wrap stays with the caller: preview drops it with a warning, export
// fails its ring.

import type { DecodeWireFrame } from "../../../shared/frameCarrier/wire";
import type { ColourStamp } from "../decoder/ffprobeColorSpace";
import { nv12FrameFromBytes, type NativeNv12Frame } from "../decoder/nv12Frame";
import { tenBitFrameFromBytes, type TenBitFrame } from "../decoder/tenBitFrame";

/// Wraps `msg`'s bytes zero-copy, on the layout its own `format` names, stamped
/// with `colorSpace`: the source's resolved colour, never anything the session
/// sent. Throws when the bytes do not match the layout (the Rust packer and the
/// builder have drifted).
///
/// LANDMINE: never `new VideoFrame` + drawImage instead. Chromium converts a
/// buffer-defined NV12 frame as BT.601 whatever its colour (ADR 0032).
export function cpuPlaneFrame(msg: DecodeWireFrame, colorSpace: ColourStamp): NativeNv12Frame | TenBitFrame {
  const layout = {
    data: msg.data,
    width: msg.width,
    height: msg.height,
    timestamp: msg.ptsUs,
    duration: msg.durUs,
    colorSpace,
  };
  return msg.format === "I420P10" ? tenBitFrameFromBytes(layout) : nv12FrameFromBytes(layout);
}
