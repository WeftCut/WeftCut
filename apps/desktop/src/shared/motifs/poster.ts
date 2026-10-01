/** The catalog shows the settled entrance, or the start of a continuous Motif. */
export function motifPosterTime(motif: { content_duration_s?: number | null }): number {
  return Math.max(0, motif.content_duration_s ?? 0);
}
