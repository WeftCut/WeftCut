/** Ephemeral desktop sampling; no screenshots or sessions are persisted. */
export type ScreenPickError = 'unsupported' | 'permission' | 'capture' | 'timeout';
export type ScreenPickReply =
  | { kind: 'picked'; hex: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; reason: ScreenPickError };
export interface ScreenPickRequest { id: string; hint: string }
export interface ScreenPickHover { id: string; hex: string }
export interface ScreenPickSnapshot {
  png: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  scaleFactor: number;
  hint: string;
}
export interface ScreenPickApi {
  start(request: ScreenPickRequest): Promise<ScreenPickReply>;
  cancel(id: string): Promise<void>;
  onHover(callback: (event: ScreenPickHover) => void): () => void;
}
/** Dedicated sandbox preload: overlay pages have no editor/file IPC access. */
export interface ScreenPickOverlayApi {
  snapshot(): Promise<ScreenPickSnapshot>;
  ready(): void;
  hover(hex: string): void;
  finish(hex: string | null): void;
  failed(): void;
}
