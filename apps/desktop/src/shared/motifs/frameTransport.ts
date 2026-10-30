export type MotifTextureFrame = { kind: 'texture'; key: string; token: string }
export type MotifBitmapFrame = { kind: 'bitmap'; token: string }
export type StoredMotifFrame = (
  | MotifTextureFrame
  | MotifBitmapFrame
  | { kind: 'png'; bytes: Uint8Array }
  | { kind: 'rgba'; width: number; height: number; rgba: Uint8Array }
) & { persisted?: boolean; cacheWriteSkipped?: boolean }

export interface MotifCacheAddress { hash: string; frame: number }
export type MotifCaptureControl =
  | { key: string; action: 'promote' | 'cancel' }
  | { key: string; action: 'bake'; bake: MotifCacheAddress }
