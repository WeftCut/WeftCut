/** Kept separate from the matcher so the dialog does not load phonetic data. */
export const CORRECTION_SCRIPT_MAX = 100_000

export interface TextCorrectionExpectation {
  script: string
  captions: Array<{ id: string; text: string; t_start_us: number; t_end_us: number }>
}
