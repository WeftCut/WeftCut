// Handle types for the PixiJS preview surface. Kept in a non-
// component module so Vite's React Fast Refresh doesn't bail on
// `PixiPreview.tsx` ("component file exports non-component values").
//
// Devtools hooks read the `window.__weftcut*` globals directly.

/// Transport interface exposed by `<PixiPreview ref={...}>`. Mirrors
/// `PreviewSurfaceHandle` so the parent's imperative handle forwards
/// play/pause/seek straight through to the underlying PIXI `PlaybackEngine`.
export interface PixiPreviewHandle {
  currentDecodeDevices(): import('./decoder/session').PreviewDecodeDevice[];
  play(): void;
  pause(): void;
  seek(tUs: number): void;
  paused(): boolean;
  /// Re-resolve every clip's preview source against the current project +
  /// the live decodability bridge, then re-composite the current frame.
  /// Used to nudge a paused clip to pick up its original the moment a
  /// mid-session probe verdict flips to "ok".
  refreshSources(): void;
}
