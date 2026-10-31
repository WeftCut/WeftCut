import type { ExportSettings } from './exportSettings';

export type ExportJobState = 'preparing' | 'rendering' | 'finalizing' | 'awaiting_retry' | 'completed' | 'failed' | 'cancelled';
export interface ExportEncoderLoad {
  encoder: string;
  device: 'gpu' | 'cpu';
  /** Encoder block utilisation for GPU, whole-system CPU utilisation for CPU. */
  utilization_percent: number | null;
}
export interface ExportJob {
  job_id: string;
  state: ExportJobState;
  output_path: string;
  filename: string;
  settings: ExportSettings;
  range: { startUs: number; endUs: number };
  agent: boolean;
  can_cancel?: boolean;
  can_retry?: boolean;
  phase?: string;
  progress?: number;
  /** Encoding only; excludes preparation and the separately reported finalization. */
  render_elapsed_ms?: number;
  /** Rolling measured estimate. Null while warming up, stalled, or frames are done. */
  estimated_remaining_ms?: number | null;
  encoder_load?: ExportEncoderLoad;
  duration_us?: number;
  error?: { code: string; message: string };
}
export interface ExportRun extends ExportJob { staging_path: string; encoded_video_path: string; encoded_audio_path: string; renderer_token: string }
export const exportTerminal = (state: ExportJobState): state is 'completed' | 'failed' | 'cancelled' => ['completed', 'failed', 'cancelled'].includes(state);

/** One mechanical wire mapping, shared by schemas, requests and results. */
export function exportWire(value: unknown, toWire: boolean): unknown {
  if (Array.isArray(value)) return value.map(v => exportWire(v, toWire));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [
    toWire ? key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`) : key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    exportWire(v, toWire),
  ]));
}
