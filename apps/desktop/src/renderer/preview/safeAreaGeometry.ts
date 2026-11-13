export const ACTION_SAFE_FRACTION = 0.93;
export const TITLE_SAFE_FRACTION = 0.9;

/// The rectangle `fraction` names, centred in the composition, in composition
/// pixels. Both margins are symmetric, which is what makes this one expression
/// rather than a per-edge table.
export function safeAreaRect(
  fraction: number,
  compW: number,
  compH: number,
): { x: number; y: number; w: number; h: number } {
  const w = compW * fraction;
  const h = compH * fraction;
  return { x: (compW - w) / 2, y: (compH - h) / 2, w, h };
}
