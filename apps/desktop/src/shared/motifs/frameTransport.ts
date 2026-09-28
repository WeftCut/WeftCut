export type MotifTextureFrame = { kind: 'texture'; key: string; token: string }
export type StoredMotifFrame =
  | MotifTextureFrame
  | { kind: 'png'; bytes: Uint8Array }
  | { kind: 'rgba'; width: number; height: number; rgba: Uint8Array }
