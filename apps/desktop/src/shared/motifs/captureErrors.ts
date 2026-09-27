/// Message of the rejection a QUEUED motif capture receives when a newer
/// request carrying the same coalesce key replaces it
/// (`main/motif/capture.ts` — the serial capture chain). Crosses the IPC
/// boundary as a plain message (error classes don't survive it), so renderer
/// callers match on this string to tell "superseded — not a failure" from a
/// real capture error.
export const CAPTURE_SUPERSEDED_MESSAGE = 'motif capture superseded by a newer request'
