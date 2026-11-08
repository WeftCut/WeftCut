import { isResourceCapacityError } from '../resource-policy'

// Typed Motif failures. One wire tag everywhere, `[motif:<code>] detail` in the
// message: napi async exports, `ipcMain.handle` and MessagePorts carry only a
// message. In-process code reads `motifErrorCode`; `decodeMotifError` runs only
// where a message crosses a process boundary.

/** What a Motif failure means to its caller.
 * - `superseded`: nobody wants the result any more; not a failure.
 * - `closed`: the consumer, reader or pool went away.
 * - `miss`: the stored frame is absent or invalid; capture it again.
 * - `content`: the Motif's own script threw, never became ready or hung twice.
 * - `timeout`: a bounded capture step ran past its deadline.
 * - `capacity`: a resource admission refused the work; retry later.
 * - `disk`: the temporary cache space or the disk is full.
 * - `oversize`: the frame or pool exceeds a fixed budget.
 * - `transient`: a file or mutex is briefly held; retrying may succeed.
 * - `device`: the GPU device or a native worker failed.
 * - `transport`: a renderer read lane failed (`MotifTransportError`). */
export type MotifErrorCode =
  | 'superseded' | 'closed' | 'miss' | 'content' | 'timeout' | 'capacity'
  | 'disk' | 'oversize' | 'transient' | 'device' | 'transport'

const CODES: ReadonlySet<string> = new Set<MotifErrorCode>([
  'superseded', 'closed', 'miss', 'content', 'timeout', 'capacity',
  'disk', 'oversize', 'transient', 'device', 'transport',
])
export const isMotifErrorCode = (code: unknown): code is MotifErrorCode =>
  typeof code === 'string' && CODES.has(code)

// LANDMINE: the tag's exact shape is shared with `native/src/motif_error.rs`;
// `errors.test.ts` and that file's test pin the same literal.
const TAG = /\[motif:([a-z]+)\] ?/

export class MotifError extends Error {
  override name = 'MotifError'
  constructor(readonly code: MotifErrorCode, readonly detail: string, options?: ErrorOptions) {
    super(`[motif:${code}] ${detail}`, options)
  }
}

/** The code of an in-process Motif failure; undefined for any other value. */
export function motifErrorCode(error: unknown): MotifErrorCode | undefined {
  return error instanceof MotifError ? error.code : undefined
}

/** A message that crossed a process boundary as a `MotifError`, wherever its
 * tag sits (Electron prefixes `Error invoking remote method '…': Error: `).
 * Untagged input comes back unchanged. */
export function decodeMotifError(error: unknown): unknown {
  if (error instanceof MotifError) return error
  const message = String((error as Error | undefined)?.message ?? error)
  const match = TAG.exec(message)
  if (!match || !isMotifErrorCode(match[1])) return error
  return new MotifError(match[1], message.slice(match.index + match[0].length), { cause: error })
}

/** Runs a native or IPC call; its rejection or throw comes back decoded. */
export async function decodingMotifErrors<T>(call: () => Promise<T>): Promise<T> {
  try { return await call() } catch (error) { throw decodeMotifError(error) }
}

/** The app-wide `resource-capacity-exceeded` refusal as a `capacity`
 * MotifError; anything else unchanged. The detail keeps the original message,
 * so `isResourceCapacityError` still matches it. */
export function asMotifCapacity(error: unknown): unknown {
  if (error instanceof MotifError || !isResourceCapacityError(error)) return error
  return new MotifError('capacity', String((error as Error | undefined)?.message ?? error), { cause: error })
}

/** The rejection a request receives when a newer one replaced it or nobody
 * wants its result any more. */
export const motifSuperseded = (): MotifError => new MotifError('superseded', 'superseded by a newer request')
