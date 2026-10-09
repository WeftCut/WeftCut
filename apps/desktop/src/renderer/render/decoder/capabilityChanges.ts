// Shared invalidation signal; each decoder still owns its capability evidence.
const listeners = new Set<() => void>();
export function onDecodeCapabilityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyDecodeCapabilityChange(): void {
  for (const listener of listeners) listener();
}
