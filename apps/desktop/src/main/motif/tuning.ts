import os from 'node:os'
import { motifBandThreads, parseMotifTuning, type ResolvedMotifTuning } from '../../shared/motifs/tuning'

/** The Motif tuning this run uses: `WEFTCUT_MOTIF_TUNING`
 * (`captureHosts=1,readsInFlight=4`) over the defaults in
 * `shared/motifs/tuning.ts`. Bad or unknown entries keep the default, with one
 * warning naming them all. main/index.ts calls it once, before any Motif
 * module exists, and hands the result on. */
export function resolveMotifTuning(
  env: Readonly<Record<string, string | undefined>>,
  parallelism: number = os.availableParallelism(),
  warn: (message: string) => void = console.warn,
): ResolvedMotifTuning {
  const { tuning, problems } = parseMotifTuning(env.WEFTCUT_MOTIF_TUNING)
  if (problems.length) warn(`[weftcut/motifs] WEFTCUT_MOTIF_TUNING: ${problems.join('; ')}; using the defaults for those`)
  return Object.freeze({ ...tuning, bandThreads: motifBandThreads(tuning, parallelism) })
}

/** The addon's `motifConfigure`, as far as a process calls it. */
interface MotifCore {
  motifConfigure?(config: { scratchIdleBytes: number; bandThreads: number }): void
}

/** Gives the native core its share of the tuning; every process that loads the
 * addon calls it once, before its first frame read or write. Until then the
 * core uses one band thread and keeps no idle buffers. */
export function configureMotifCore(core: unknown, tuning: ResolvedMotifTuning): void {
  const configure = (core as MotifCore | null)?.motifConfigure
  if (typeof configure !== 'function') throw new Error('The native core has no motifConfigure: rebuild it')
  configure({ scratchIdleBytes: tuning.scratchIdleBytes, bandThreads: tuning.bandThreads })
}
