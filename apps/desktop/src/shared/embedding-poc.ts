/** Throwaway 1 fps visual-search experiment. No persisted project state. */
export interface EmbeddingPocStatus {
  phase: 'idle' | 'loading' | 'indexing' | 'ready' | 'cancelled' | 'error';
  projectId: string | null;
  totalVideos: number;
  completedVideos: number;
  frames: number;
  elapsedSeconds: number;
  currentVideo: string;
  device: string;
  failures: string[];
  message: string;
}

export interface EmbeddingPocHit {
  mediaId: string;
  label: string;
  timeUs: number;
  score: number;
  thumbnail: string;
}

export interface EmbeddingPocResults {
  hits: EmbeddingPocHit[];
  queryMs: number;
  frames: number;
}

export interface EmbeddingPocApi {
  status(): Promise<EmbeddingPocStatus>;
  start(): Promise<EmbeddingPocStatus>;
  cancel(): Promise<EmbeddingPocStatus>;
  search(query: string): Promise<EmbeddingPocResults>;
}
