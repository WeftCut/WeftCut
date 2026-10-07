// Opens a weftcut-media:// media file through mediabunny, lazily, and exposes the
// primary video track + an EncodedPacketSink for it. Explicit format list
// (MP4/MOV/Matroska/WebM) — NOT ALL_FORMATS — to keep the bundle lean.

import {
  Input,
  EncodedPacketSink,
  MP4,
  QTFF,
  MATROSKA,
  WEBM,
  type InputVideoTrack,
} from "mediabunny";
import { MediaRangeSource } from "./MediaRangeSource";

export interface OpenedMedia {
  /// The primary video track; `getDecoderConfig()` gives the WebCodecs config.
  videoTrack: InputVideoTrack;
  /// Packet source for seek + forward decode.
  packetSink: EncodedPacketSink;
  /// Release the Input + abort in-flight Range reads.
  dispose: () => void;
}

export async function openMediaInput(assetUrl: string, signal?: AbortSignal): Promise<OpenedMedia> {
  signal?.throwIfAborted();
  const mediaSource = new MediaRangeSource(assetUrl);
  let input: Input | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    // Abort even if construction or Input.dispose itself fails.
    mediaSource.dispose();
    input?.dispose();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    input = new Input({ formats: [MP4, QTFF, MATROSKA, WEBM], source: mediaSource.source });
    const videoTrack = await input.getPrimaryVideoTrack();
    signal?.throwIfAborted();
    if (!videoTrack) throw new Error(`openMediaInput: no video track in ${assetUrl}`);
    return { videoTrack, packetSink: new EncodedPacketSink(videoTrack), dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
