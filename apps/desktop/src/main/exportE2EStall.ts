// E2E builds only: the stalled-encoder spec
// (e2e/electron/export-stalled-encoder.spec.ts) needs an export whose encoder
// stops responding. With WEFTCUT_E2E_STALLED_ENCODER_MS set, main asks the
// native video sink for a stand-in encoder that never reads its input,
// watched at that stall limit (`e2e_stalled_encoder_ms` in
// native/src/export/videosink.rs). index.ts reads the variable only when the
// build carries the E2E flag.

/** `WEFTCUT_E2E_STALLED_ENCODER_MS`: a stall limit in ms, or null. */
export function stalledEncoderLimitMs(value: string | undefined): number | null {
  if (!value || !/^\d{1,7}$/.test(value)) return null
  const ms = Number(value)
  return ms > 0 ? ms : null
}
