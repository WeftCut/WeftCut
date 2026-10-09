/** Emitted by the workspace write-back after confirming equal content hashes.
 * This survives coalesced summaries: renderers need not observe the intermediate
 * hash-only summary to carry decode evidence from source to workspace copy. */
export const MEDIA_SOURCE_RELOCATED = 'media:source-relocated';
export interface MediaSourceRelocated {
  media_id: string;
  from: string;
  to: string;
  content_hash: string;
  size_bytes: number;
}
