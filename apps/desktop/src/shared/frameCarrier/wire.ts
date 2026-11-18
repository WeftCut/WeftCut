// What a decode session's port carries, in both directions. The message types
// come from the decode addon's generated `index.d.ts` (the Rust `DecodeMsg` is
// their one source); this module only adapts them to what arrives on the far
// side of a port. Transport: docs/export-ipc-transport.md § Decode-in.

import type {
  DecodeMsg,
  ExportDecodeOpenInfo,
  PreviewDecodeOpenInfo,
  PreviewDecodeOptions,
} from '@weftcut/native-decode'

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

/** How a preview session decodes and what it ships, and its open reply. */
export type { PreviewDecodeOpenInfo, PreviewDecodeOptions }

/** Hands back the lease of a frame that has left the consumer. */
export type ReleaseCommand = { type: 'release'; lease: number }

/** Ends the session. Every pipeline takes it; the session host handles it. */
export type CloseCommand = { type: 'close' }

/** Up an export session's port: `range` asks for every frame in `[aUs, bUs]`. */
export type ExportDecodeCommand = { type: 'range'; aUs: number; bUs: number } | ReleaseCommand

/** Up a preview session's port: `request` asks for every frame from `targetUs`
 * through the session's horizon, in answer to `requestId`. A new id is a
 * discontinuity; frames name the request they answer. */
export type PreviewDecodeCommand = { type: 'request'; targetUs: number; requestId: number } | ReleaseCommand

/** Anything a consumer posts up a decode session's port. */
export type DecodeCommand = ExportDecodeCommand | PreviewDecodeCommand | CloseCommand
