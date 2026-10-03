/** Selection and inspection are always allowed. Only lock controls bypass this. */
export function layerEditLock(layer: { locked: boolean }, track?: { locked: boolean }): 'track' | 'layer' | null {
  return track?.locked ? 'track' : layer.locked ? 'layer' : null
}
