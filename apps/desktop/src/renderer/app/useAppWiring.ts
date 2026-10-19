import { listen } from "@/bridge/events";
import { getCurrentWindow } from "@/bridge/window";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  audioFxSnapshot,
  keybindingsGet,
  type AudioFxStatusEvent,
  type KeybindingsMap,
  motifStalenessReport,
  type MotifStaleEntry,
  ping,
} from "../ipc";
import { useAgentActivity, wireAgentActivity } from "../agent/activityStore";
import { wireComputeJobs } from "../compute/computeJobsStore";
import { wireComputeJobNotices } from "../compute/computeJobNotices";
import { wireLogStream } from "../logs/store";
import { wireSearchIndex } from "../search/searchIndexStore";
import { bootAudioFxStore } from "../state/audioFxStore";
import { useProjectStore, wireProjectStore } from "../state/projectStore";
import { wireProxyPrefStore } from "../state/proxyPreferenceStore";
import { wireDecodeComponent } from "../settings/decodeComponentStore";

/// Owns the App-root backend wiring: the pong healthcheck, keybindings +
/// agent activity snapshots and independent view selection, the on-open stale-motifs pull, and the
/// stream-wiring effects (status log, project-state mirror, app-settings,
/// and the single project-state subscription shared by App and preview).
export function useAppWiring(): {
  pong: string;
  keybindings: KeybindingsMap;
  setKeybindings: React.Dispatch<React.SetStateAction<KeybindingsMap>>;
  agentMode: boolean;
  exitAgentMode: () => Promise<void>;
  enterAgentMode: () => Promise<void>;
  staleMotifs: MotifStaleEntry[];
  setStaleMotifs: React.Dispatch<React.SetStateAction<MotifStaleEntry[]>>;
} {
  const [pong, setPong] = useState<string>("…");
  // User shortcut overrides. Loaded once on mount; refreshed when the
  // Settings → Keyboard panel writes (it calls back via the
  // `onKeybindingsChanged` prop). The map is `Record<string, string[]>`
  // on the wire; we widen-cast into `OverrideMap` since the frontend
  // catalogue (`ACTION_DEFS`) is the validator. Unknown action ids in
  // the file are silently ignored at dispatch time.
  const [keybindings, setKeybindings] = useState<KeybindingsMap>({});
  const agentMode = useAgentActivity(s => s.mode === "agent");

  // §7-B on-open staleness: App mounts exactly once per successful project
  // open (every open path remounts it), so a mount-time pull IS the
  // once-per-open check. Read-only; the ack happens on dismiss.
  const [staleMotifs, setStaleMotifs] = useState<MotifStaleEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void motifStalenessReport()
      .then((r) => {
        if (!cancelled && r.length > 0) setStaleMotifs(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    ping().then(setPong).catch((e) => setPong(`error: ${String(e)}`));
    keybindingsGet().then(setKeybindings).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void wireAgentActivity().then(unlisten => {
      if (cancelled) unlisten(); else stop = unlisten;
    });
    return () => { cancelled = true; stop?.(); };
  }, []);

  // Clip-compute jobs (ADR 0121): human and agent transcribe / describe alike.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void wireComputeJobs().then(unlisten => {
      if (cancelled) unlisten(); else stop = unlisten;
    });
    // The completion notice watches the same mirror (`computeJobNotices.ts`).
    const stopNotices = wireComputeJobNotices();
    return () => { cancelled = true; stop?.(); stopNotices(); };
  }, []);

  const exitAgentMode = useCallback(async () => { useAgentActivity.setState({ mode: "editor" }); }, []);
  const enterAgentMode = useCallback(async () => { useAgentActivity.setState({ mode: "agent" }); }, []);

  // Wire the status-log stream: seed from `log_list`, then subscribe to
  // `log:entry` events. Pre-workspace this is a no-op (backend bus is
  // None). The Zustand store backs the status bar's selectors.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireLogStream();
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // One project mirror for App, panels and preview. A second independent
  // fetch/publish here causes two full React render passes for every edit.
  // The search index rides along on the same effect: it reads
  // `useProjectStore`'s summary, so it wires right after the store itself
  // is live.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unwireSearch: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireProjectStore();
      const unwire = wireSearchIndex();
      if (cancelled) {
        u();
        unwire();
        return;
      }
      unlisten = u;
      unwireSearch = unwire;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (unwireSearch) unwireSearch();
    };
  }, []);

  // Audio-effect bake mirror (ADR 0063). Seeded from the baker's snapshot and
  // kept live by `audio_fx:status`; the preview's audio source, the timeline's
  // waveform key and the effect card's status line all read it. Wired here
  // rather than under the panel that shows it: playback reads the same mirror,
  // so it has to be live whether or not any inspector is open.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await bootAudioFxStore({
        listen: (event, handler) =>
          listen<AudioFxStatusEvent>(event, handler),
        snapshot: () => audioFxSnapshot(),
        onProjectSwitch: (cb) =>
          useProjectStore.subscribe((s, prev) => {
            if (s.summary?.project_id !== prev.summary?.project_id) cb();
          }),
      });
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Proxy-preference mirror (prefer_proxies + proxy_overrides). Hydrates
  // immediately and re-hydrates whenever the project summary swaps (new
  // project / reload) — see `state/proxyPreferenceStore.ts`. Unlike the
  // other stream wirings above, `wireProxyPrefStore` is synchronous (it
  // fires the initial fetch fire-and-forget and returns the project-store
  // unsubscribe immediately), so no cancelled/async dance is needed.
  useEffect(() => {
    return wireProxyPrefStore();
  }, []);

  // Native-decode component availability (level-0 gate). Pulled once on mount;
  // availability is fixed for a process lifetime (the require is memoized in
  // main), so this is fire-and-forget — no subscription, no unlisten.
  useEffect(() => {
    void wireDecodeComponent();
  }, []);

  return {
    pong,
    keybindings,
    setKeybindings,
    agentMode,
    exitAgentMode,
    enterAgentMode,
    staleMotifs,
    setStaleMotifs,
  };
}

/// OS window-title binding.
export function useWindowTitle(projectName: string | null | undefined): void {
  const { t, i18n } = useTranslation();
  // Bind the OS window title to the project name (AE-style: the
  // project's identity lives in the window chrome, not in an in-app
  // bar). Falls back to the bare app title when no project is loaded
  // yet. Re-runs on locale flip so the dash / phrasing follows the
  // user's language preference. Resets to the bare title on unmount
  // (Save and Close) so the StartupScreen doesn't inherit a stale
  // project name in the OS title bar.
  useEffect(() => {
    const win = getCurrentWindow();
    const next = projectName
      ? t("app.window_title", { name: projectName })
      : t("app.title");
    void win.setTitle(next).catch(() => {});
  }, [projectName, i18n.resolvedLanguage, t]);
  useEffect(() => {
    return () => {
      void getCurrentWindow().setTitle("WeftCut").catch(() => {});
    };
  }, []);
}
