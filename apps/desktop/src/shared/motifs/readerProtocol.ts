// The Motif reader utility's port protocol (ADR 0154). A renderer worker asks
// the utility process directly on a `MessagePortMain`; main is not on the read
// path. Requests name a cache address and a divisor, never a path.

/** Playback Resolution divisors a read may ask for. Export always uses 1. */
export const MOTIF_READER_DIVISORS = [1, 2, 4] as const
export type MotifReaderDiv = typeof MOTIF_READER_DIVISORS[number]
export const isMotifReaderDiv = (div: unknown): div is MotifReaderDiv =>
  (MOTIF_READER_DIVISORS as readonly unknown[]).includes(div)

/** Worker → utility. */
export interface MotifReadRequest { id: number; hash: string; frame: number; div: MotifReaderDiv }

/** Native stage times of one read, in milliseconds. */
export interface MotifReadTiming { readMs: number; decodeMs: number; hashMs: number; scaleMs: number }

/** Scaled straight RGBA; `width` and `height` are the input size divided by
 * the divisor, rounded up. */
export interface MotifReadPixels { width: number; height: number; rgba: Uint8Array; timing: MotifReadTiming }

/** Utility → worker. A miss means the frame is absent, invalid, or there is no
 * workspace. An error is a utility-side failure that is not about the file:
 * it is a transport failure, never a miss. */
export type MotifReadReply =
  | { id: number; frame: MotifReadPixels }
  | { id: number; miss: true }
  | { id: number; error: string }

/** Main → utility. `workspace` replaces the raster root and its generation;
 * both are null during a workspace transition. `port` carries one document's
 * `port1`, which the utility acknowledges with `port-ready`; `retire` closes
 * it again. */
export type MotifReaderControl =
  | { type: 'workspace'; generation: number | null; root: string | null }
  | { type: 'port'; id: number }
  | { type: 'retire'; id: number }

/** Utility → main: a stored frame could not be read. Main drops it from
 * coverage only when `generation` is still current. */
export interface MotifReaderMissReport { type: 'miss'; generation: number; hash: string; frame: number }

/** Utility → main: the utility attached `port1` of connection `id`. Main
 * posts `port2` to the document only then, so a page never holds a port the
 * utility died before taking. */
export interface MotifReaderPortReady { type: 'port-ready'; id: number }

/** Utility → main. */
export type MotifReaderReport = MotifReaderMissReport | MotifReaderPortReady

/** Main → renderer channels. The renderer asks with `motif:reader-connect`. */
export const MOTIF_READER_CONNECT = 'motif:reader-connect'
export const MOTIF_READER_PORT = 'motif:reader-port'
export const MOTIF_READER_RESET = 'motif:reader-reset'
