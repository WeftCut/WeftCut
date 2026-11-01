import type { ExportSettings } from './exportSettings';
import type { ResourceWaitReason } from './export-resources';
import type { ResourceHolder } from './resource-policy';

/** `queued`: admission waits for the resource budget, for as long as it takes. */
export type ExportJobState = 'queued' | 'preparing' | 'rendering' | 'finalizing' | 'awaiting_retry' | 'completed' | 'failed' | 'cancelled';
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
  duration_us?: number;
  /** While `queued`: why admission waits and what holds the budget, largest
   *  first (the `ResourceBusy` holders). */
  queued?: { reason: Exclude<ResourceWaitReason, 'budget-too-small'>; holders: ResourceHolder[] };
  /** A typed failure also carries its variant (`error`) and data, flat. */
  error?: { code: string; message: string; [key: string]: unknown };
}
export interface ExportRun extends ExportJob { staging_path: string; encoded_video_path: string; encoded_audio_path: string; renderer_token: string }
export const exportTerminal = (state: ExportJobState): state is 'completed' | 'failed' | 'cancelled' => ['completed', 'failed', 'cancelled'].includes(state);

/** The keys whose wire name is not the mechanical one: a range is timeline
 *  time, and its wire name says so (`t_start_us`, docs/mcp.md "Time base in
 *  the name"). */
const RENAMED: Readonly<Record<string, string>> = { startUs: 't_start_us', endUs: 't_end_us' };
const UNRENAMED: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(RENAMED).map(([k, v]) => [v, k]));

/** One wire mapping, shared by schemas, requests and results: snake_case
 *  mechanically, except the `RENAMED` keys. */
export function exportWire(value: unknown, toWire: boolean): unknown {
  if (Array.isArray(value)) return value.map(v => exportWire(v, toWire));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [
    toWire ? RENAMED[key] ?? key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`) : UNRENAMED[key] ?? key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    exportWire(v, toWire),
  ]));
}
