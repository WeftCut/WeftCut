/** The pause threshold's two spellings. The project file stores a linear peak
 *  amplitude (`pause_review.threshold_amp`, shared with the Rust model); every
 *  surface a person or an agent reads speaks dBFS, like `detect_pauses`. */
export const pauseAmpFromDb = (db: number): number => 10 ** (db / 20)
/** dBFS to 0.1 dB; null for silence, which has no finite level. */
export const pauseDbFromAmp = (amp: number): number | null => (amp > 0 ? Math.round(200 * Math.log10(amp)) / 10 : null)
