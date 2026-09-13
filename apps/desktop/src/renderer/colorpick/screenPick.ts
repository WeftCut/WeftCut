import type { ScreenPickReply } from '../../shared/screenPick';

export function screenPickAvailable(): boolean {
  return typeof window.api?.colorPick?.start === 'function';
}

/** Own the renderer subscription/cancellation for one main-process request. */
export async function screenPick(signal: AbortSignal, hint: string, onHover?: (hex: string) => void): Promise<ScreenPickReply> {
  if (signal.aborted) return { kind: 'cancelled' };
  if (!screenPickAvailable()) return { kind: 'error', reason: 'unsupported' };
  const id = crypto.randomUUID();
  const api = window.api.colorPick;
  const unsubscribe = api.onHover(event => {
    if (!signal.aborted && event.id === id) onHover?.(event.hex);
  });
  const cancel = (): void => { void api.cancel(id).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const reply = await api.start({ id, hint });
    return signal.aborted ? { kind: 'cancelled' } : reply;
  } catch {
    return { kind: 'error', reason: 'capture' };
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', cancel);
  }
}
