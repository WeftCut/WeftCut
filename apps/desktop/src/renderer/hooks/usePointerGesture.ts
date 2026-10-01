import { useCallback, useEffect, useRef } from "react";

interface Gesture {
  move(event: PointerEvent): void;
  release(event: PointerEvent): void;
  cancel(): void;
}

/// One owned pointer session per mounted caller. Release commits; cancellation,
/// Escape, blur, replacement and unmount only abort. No window listener survives
/// its session, and a second pointer cannot move or finish the first one's edit.
export function usePointerGesture() {
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  return useCallback((pointerId: number, gesture: Gesture) => {
    cancelRef.current?.();
    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", abort);
      cancelRef.current = null;
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId) gesture.move(event);
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      teardown();
      gesture.release(event);
    };
    const abort = () => {
      teardown();
      gesture.cancel();
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) abort();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") abort();
    };
    cancelRef.current = abort;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", abort);
  }, []);
}
