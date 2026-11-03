// E2E builds only: the Motif reader conformance spec
// (e2e/electron/motif-frame-reader.spec.ts, ADR 0154) needs a read that is
// inside the utility process, admitted under a workspace generation, and not
// answered yet, so it can kill the process or switch the workspace mid-read.
// The utility entry wires this in only when the build carries the E2E flag.

/** `WEFTCUT_E2E_MOTIF_READER_HOLD_FRAME`: the frame number to hold, or null. */
export function motifReadHoldFrame(value: string | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null
  return Number(value)
}

const FRAME_FILE = /(?:^|[\\/])(\d+)\.wfrm$/

/** Wraps the utility's file read. A read of frame `frame` (any hash) waits
 * until a read of frame `frame + 1` arrives, then proceeds on the path it was
 * admitted with. A process that dies first never answers it. */
export function holdMotifReads<T>(
  read: (file: string, div: number) => Promise<T>,
  frame: number,
): (file: string, div: number) => Promise<T> {
  const held: (() => void)[] = []
  return async (file, div) => {
    const match = FRAME_FILE.exec(file)
    const requested = match ? Number(match[1]) : null
    if (requested === frame) await new Promise<void>(resolve => held.push(resolve))
    else if (requested === frame + 1) for (const release of held.splice(0)) release()
    return read(file, div)
  }
}
