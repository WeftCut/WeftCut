import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Observe an attempted drag without creating a timeline edit gesture. */
export function useLockedClipFeedback(locked: boolean) {
  const [blocked, setBlocked] = useState(false);
  const [emphasized, setEmphasized] = useState(false);
  const cleanup = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setBlocked(false);
    setEmphasized(false);
    return () => {
      cleanup.current();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [locked]);

  const start = (event: ReactPointerEvent<HTMLElement>) => {
    cleanup.current();
    if (timer.current !== null) clearTimeout(timer.current);
    setBlocked(false);
    setEmphasized(false);
    const { clientX, clientY, pointerId, currentTarget: target } = event;
    let attempted = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || attempted) return;
      if (Math.hypot(e.clientX - clientX, e.clientY - clientY) < 4) return;
      attempted = true;
      // Retain cursor feedback even when the pointer leaves this clip.
      target.setPointerCapture?.(pointerId);
      setBlocked(true);
      setEmphasized(true);
    };
    const remove = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      window.removeEventListener("blur", finish);
      window.removeEventListener("keydown", keydown);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    };
    const finish = () => {
      remove();
      setBlocked(false);
      if (attempted) timer.current = setTimeout(() => setEmphasized(false), 600);
    };
    const finishPointer = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish();
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    cleanup.current = remove;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", finish);
    window.addEventListener("keydown", keydown);
  };

  return { blocked, emphasized, start };
}
