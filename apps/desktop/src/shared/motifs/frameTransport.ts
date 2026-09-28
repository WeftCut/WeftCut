export type MotifTextureFrame = { kind: 'texture'; key: string; token: string }
export type StoredMotifFrame = (
  | MotifTextureFrame
  | { kind: 'png'; bytes: Uint8Array }
  | { kind: 'rgba'; width: number; height: number; rgba: Uint8Array }
) & { persisted?: boolean }

export interface MotifCacheAddress { hash: string; frame: number }
export type MotifCaptureControl =
  | { key: string; action: 'promote' | 'cancel' }
  | { key: string; action: 'bake'; bake: MotifCacheAddress }
