// Files the OS asked WeftCut to open (ADR 0181), as the window receives them:
// main keeps the latest one until the surface on screen takes it. The start
// screen and the editor each mount the hook with what their Open does; only
// one of them is mounted at a time.

import { useEffect, useRef } from "react";
import { listen } from "@/bridge/events";
import { FILE_OPEN_REQUEST_EVENT } from "../../shared/fileOpen";

/// Whether a file waits to be opened. Launch reads it to skip reopening the
/// last project: the file the user opened the app with comes first.
export const fileOpenPending = (): Promise<boolean> => window.api.fileOpen.pending();

/// Hands each requested file to `handle` while `ready`, at mount and whenever
/// one arrives. A request that arrives while not ready waits in main and is
/// taken once ready. Taking and handling are one step that unmounting does
/// not cancel: a taken request is gone from main, so dropping it there would
/// lose the user's double-click.
export function useFileOpenRequests(handle: (file: string) => void, ready: boolean): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => {
    if (!ready) return;
    const deliver = () => {
      void window.api.fileOpen.take().then((file) => {
        if (file !== null) handleRef.current(file);
      });
    };
    deliver();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen(FILE_OPEN_REQUEST_EVENT, deliver).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [ready]);
}
