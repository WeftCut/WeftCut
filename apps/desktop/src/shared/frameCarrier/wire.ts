// What a decode session's port carries, in both directions. The message types
// come from the decode addon's generated `index.d.ts` (the Rust `DecodeMsg` is
// their one source); this module only adapts them to what arrives on the far
// side of a port. Transport: docs/export-ipc-transport.md § Decode-in.

import type { DecodeMsg, ExportDecodeOpenInfo } from '@weftcut/native-decode'

/** A `DecodeMsg` after structured clone: the addon's `Buffer` arrives as a
 * plain `Uint8Array`. Keyed on the field, not the `Buffer` type, because the
 * shared and renderer projects compile without Node's types. */
type Cloned<M> = M extends { data: unknown } ? Omit<M, 'data'> & { data: Uint8Array } : M

/** One message down a decode session's port, in the order the session sent it. */
export type DecodeWireMsg = Cloned<DecodeMsg>

/** A `bytes` message: one decoded frame and the lease that hands it back. */
export type DecodeWireFrame = Extract<DecodeWireMsg, { kind: 'bytes' }>

/** Reply of an export decode open: dimensions, source colour, start PTS. */
export type { ExportDecodeOpenInfo }

/** One command up a decode session's port. `range` asks for every frame in
 * `[aUs, bUs]`; `release` hands back the lease of a frame that has left the
 * consumer; `close` ends the session. */
export type DecodeCommand =
  | { type: 'range'; aUs: number; bUs: number }
  | { type: 'release'; lease: number }
  | { type: 'close' }
