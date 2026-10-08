/// Synthetic decoder-pool keys for an in-flight no-flash source-swap.
///
/// The preview pool keys handles by `layerId` and shares a `SourceMedia`
/// (with an immutable URL) by `mediaId`. To spin up a SECOND handle on a new
/// URL for the same source — without disturbing the original that's still on
/// screen — we acquire under derived keys: a fresh `layerId` so the pool
/// builds a new handle, and a fresh `mediaId` so it builds a new `SourceMedia`
/// on the new URL rather than reusing the original's.
///
/// These two layer slots alternate across path changes, engine switches and
/// original/proxy toggles. The media key for an actual acquire additionally
/// includes the resolved identity because different clips can switch at
/// different times and SourceMedia owns an immutable URL.
export function swapKeys(
  layerId: string,
  mediaId: string,
): { swapLayerId: string; swapMediaId: string } {
  return { swapLayerId: `${layerId}#swap`, swapMediaId: `${mediaId}#swap` };
}

/** Acquire the free layer slot, sharing media only for the same decode target. */
export function nextSwapKeys(
  layerId: string,
  mediaId: string,
  activePoolKey: string,
  sourceKey: string,
): { swapLayerId: string; swapMediaId: string } {
  const alternate = swapKeys(layerId, mediaId);
  return {
    swapLayerId: activePoolKey === layerId ? alternate.swapLayerId : layerId,
    swapMediaId: `${alternate.swapMediaId}:${sourceKey}`,
  };
}
