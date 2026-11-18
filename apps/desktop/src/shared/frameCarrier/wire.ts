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

/** What a shared texture travels with from main to the preload's slot reader:
 * slot `slot` of producer `key` (a GPU session's id, or a Motif pool's key). */
export interface SlotTag {
  key: string
  slot: number
}

/** A `slot` message: the session filled pool slot `slot`, fill generation
 * `gen`. */
export type DecodeWireSlot = Extract<DecodeWireMsg, { kind: 'slot' }>

/** What the preload's read of one slot cost, in milliseconds: `getVideoFrame`,
 * `createImageBitmap`, and the whole read until the bitmap is posted on. */
export interface SlotReadTiming {
  gvfMs: number
  cibMs: number
  residentMs: number
}

/** A `slot` message as its consumer receives it: the preload has read the
 * slot into `bitmap`, or failed to and says why in `error`. Either way the
 * consumer owns the slot and returns it with one `release` of its `(slot,
 * gen)` once nothing can still be reading it. */
export type SlotReadMsg = DecodeWireSlot & (
  | { bitmap: ImageBitmap; timing: SlotReadTiming; error?: undefined }
  | { bitmap?: undefined; error: string }
)

/** One message down a slot session's port as its consumer receives it. */
export type SlotSessionMsg = SlotReadMsg | Exclude<DecodeWireMsg, { kind: 'slot' }>

/** Hands back the lease of a frame that has left the consumer. */
export type ReleaseCommand = { type: 'release'; lease: number }

/** Hands back pool slot `slot` once its read has completed. `gen` echoes the
 * `slot` message's generation, so native ignores a release of a fill it has
 * since reclaimed. */
export type SlotReleaseCommand = { type: 'release'; slot: number; gen: number }

/** Up an export session's port: `range` asks for every frame in `[aUs, bUs]`. */
export type ExportDecodeCommand = { type: 'range'; aUs: number; bUs: number } | ReleaseCommand

/** Up a preview session's port: `request` asks for every frame from `targetUs`
 * through the session's horizon, in answer to `requestId`. A new id is a
 * discontinuity; frames name the request they answer. */
export type PreviewDecodeCommand = { type: 'request'; targetUs: number; requestId: number } | ReleaseCommand

/** Up a GPU preview session's port: `request` moves the decode anchor to
 * `targetUs`; the session fills slots from there through its lookahead. */
export type PreviewGpuCommand = { type: 'request'; targetUs: number } | SlotReleaseCommand

/** Anything a consumer sends up a decode session's port (`decodeSession:cmd`).
 *
 * LANDMINE: closing is not one. The preload closes a session by id
 * (`decodeSession:close`) on the route opens take: a close up the port would
 * reach main after an open asked for after it, which main then refuses while
 * the old session still holds its reservation. */
export type DecodeCommand = ExportDecodeCommand | PreviewDecodeCommand | PreviewGpuCommand
