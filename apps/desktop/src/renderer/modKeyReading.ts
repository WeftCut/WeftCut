// Mod (⌘ on macOS, Ctrl elsewhere) as a live gesture or hover reads it, for
// every surface where holding it suspends snapping. A pointer event carries the
// modifier, but pressing or releasing the key with the pointer still sends no
// pointer event, so a surface that read Mod only from pointer events showed one
// landing and committed another. While a watch listens, the key's own events
// re-report it, and `held()` is the one reading both the preview and the commit
// use.

import { useEffect, useEffectEvent, useState } from "react";
import { modKeyHeld } from "./platform";

export interface ModifierFlags {
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface ModKeyReading {
  /// Mod as the surface last showed it: from the last pointer event observed, or
  /// the last key event that changed it, whichever came later.
  held(): boolean;
  /// Records a pointer event's Mod state and returns it.
  observe(e: ModifierFlags): boolean;
  /// Re-reports Mod from key events until the returned detach runs. `onChange`
  /// fires only when a key event changes the reading; the caller re-evaluates its
  /// preview at the last pointer position with the new value.
  listen(onChange: (held: boolean) => void): () => void;
}

export function createModKeyReading(): ModKeyReading {
  let held = false;
  return {
    held: () => held,
    observe: (e) => {
      held = modKeyHeld(e);
      return held;
    },
    listen: (onChange) => {
      const set = (next: boolean): void => {
        if (next === held) return;
        held = next;
        onChange(next);
      };
      const onKey = (e: KeyboardEvent): void => set(modKeyHeld(e));
      // A Mod released while another window has focus sends no keyup here
      // (⌘-Tab away is the common case), so a reading left at "held" would stay
      // wrong until the next pointer event.
      const onBlur = (): void => set(false);
      // Capture: a shortcut handler that stops propagation must not hide the
      // modifier from a gesture in flight.
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
        window.removeEventListener("blur", onBlur);
      };
    },
  };
}

/// A component's `ModKeyReading`, listening to the key only while `active` (a
/// gesture in flight, a hover showing a preview) and detached on deactivation
/// and unmount. `onChange` is read at event time, so it may close over render
/// state without re-attaching the listeners.
export function useModKeyReading(
  active: boolean,
  onChange: (held: boolean) => void,
): ModKeyReading {
  const [reading] = useState(createModKeyReading);
  const onChangeEvent = useEffectEvent(onChange);
  useEffect(() => {
    if (!active) return;
    return reading.listen((held) => onChangeEvent(held));
  }, [active, reading]);
  return reading;
}
