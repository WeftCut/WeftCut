import { MOTIF_TUNING_DEFAULTS, type MotifTuning } from '../../../shared/motifs/tuning';

let tuning: MotifTuning | undefined;

/** The Motif tuning main resolved for this window (`shared/motifs/tuning.ts`),
 * passed through the preload. A window main started without it, and a test,
 * get the defaults. */
export function motifTuning(): MotifTuning {
  return tuning ??= (typeof window === 'undefined' ? null : window.api?.app?.motifTuning) ?? MOTIF_TUNING_DEFAULTS;
}
