/** Leads the text of every error from an ffmpeg child its progress watchdog
 * stopped (`STALLED_TAG` in native/src/ffmpeg/child.rs; keep the two
 * identical). The rest of the text stays the technical detail. */
export const FFMPEG_STALLED = 'ffmpeg-stalled';
export const isFfmpegStallError = (error: unknown): boolean => String(error).includes(FFMPEG_STALLED);
