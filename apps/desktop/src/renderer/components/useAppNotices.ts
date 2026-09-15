import { useEffect, useState } from "react";
import type { AppNotice } from "../../shared/ipc";

/// Pulls process-level capability notices once the renderer is ready. The main
/// process collects them during startup, so a pull model avoids losing notices
/// before React has mounted. These are persistent environment states rather
/// than dismissible banners; consumers decide how prominently to surface them.
///
/// The `app:notices` event is the other half of that: a state the user can
/// recover from in-app (so far, the agent skill's "try again") has to be able
/// to retract its own notice, and by then the pull has already happened.
/// Startup still pulls, because a push then would have no subscriber yet.
export function useAppNotices(): AppNotice[] {
  const [notices, setNotices] = useState<AppNotice[]>([]);

  useEffect(() => {
    let alive = true;
    window.api.app
      .notices()
      .then((next) => {
        if (alive) setNotices(next);
      })
      .catch(() => {
        // Capability notices are best-effort and must never block the editor.
      });
    const off = window.api.on("app:notices", (payload) => {
      if (alive) setNotices(payload as AppNotice[]);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return notices;
}
