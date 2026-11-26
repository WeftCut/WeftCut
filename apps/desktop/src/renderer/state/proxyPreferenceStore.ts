// Renderer mirror of the two proxy-preference ProjectSettings fields
// (prefer_proxies + proxy_overrides). PixiPreview reads it live per
// ensureClip; the UI subscribes via atomic selectors. Setters write
// through the unrecorded update_project_settings mutation, then update
// the store optimistically (updateProjectSettings returns void). Follows
// the appSettingsStore pattern. It also asks for the quick proxies those
// fields want and no job builds. See docs/preview.md §Proxies.

import { create } from "zustand";

import { generateQuickProxy, getProjectSettings, updateProjectSettings, type MediaSummary } from "../ipc";
import { quickProxyPath } from "../render/decodeRoute";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useProjectStore } from "./projectStore";

interface ProxyPrefState {
  preferProxies: boolean;
  overrides: Record<string, boolean>;
  hydrate: (v: { preferProxies: boolean; overrides: Record<string, boolean> }) => void;
}

export const useProxyPrefStore = create<ProxyPrefState>((set) => ({
  preferProxies: false,
  overrides: {},
  hydrate: (v) => set({ preferProxies: v.preferProxies, overrides: v.overrides }),
}));

/** Effective per-clip intent: a per-clip override wins over the global toggle. */
export function proxyIntent(mediaId: string): boolean {
  const s = useProxyPrefStore.getState();
  return s.overrides[mediaId] ?? s.preferProxies;
}

/** Clips a quick proxy was asked for in this project, so
 *  `requestSkippedQuickProxies` asks once. */
const requested = new Set<string>();
/** The project whose settings the store holds: `requestSkippedQuickProxies`
 *  reads no other project's intent. */
let hydratedProject: string | undefined;

/** Ask for one clip's missing quick proxy. A request for one still building
 *  joins that build (jobs/singleflight.rs). */
export function requestQuickProxy(mediaId: string): void {
  requested.add(mediaId);
  void generateQuickProxy(mediaId).catch((error) => console.warn("quick proxy request failed:", error));
}

/** A clip that previews from proxy but has no quick proxy to read. A build
 *  needs the final cache key, as MediaPool's Preview source menu asks, and the
 *  file: for an offline one it would only fail. */
function lacksWantedQuickProxy(m: MediaSummary): boolean {
  return m.kind === "Video" && m.decode_route.route !== "bypass" && quickProxyPath(m) === null
    && m.content_hash != null && m.available && proxyIntent(m.id);
}

export async function setPreferProxies(v: boolean): Promise<void> {
  await updateProjectSettings({ prefer_proxies: v });
  useProxyPrefStore.setState({ preferProxies: v });
  if (v) buildMissingQuickProxies();
}

/** Turning proxies on asks for every missing quick proxy, as the per-clip
 *  override does for one clip: the ones an import left out and any the cache
 *  dropped. A clip pinned to its original is left alone. */
function buildMissingQuickProxies(): void {
  for (const m of useProjectStore.getState().mediaById.values()) {
    if (lacksWantedQuickProxy(m)) requestQuickProxy(m.id);
  }
}

/** With `build_quick_proxies_on_import` off, an import leaves a DirectExport
 *  clip without its quick proxy. A clip that already previews from proxy
 *  (Prefer Proxies, its per-clip override) asks for one when its route lands
 *  or its project opens; once, so a failed build is not retried on every
 *  summary. */
function requestSkippedQuickProxies(): void {
  const { summary, mediaById } = useProjectStore.getState();
  if (!summary || summary.project_id !== hydratedProject) return;
  if (useAppSettingsStore.getState().settings.build_quick_proxies_on_import) return;
  for (const m of mediaById.values()) {
    if (m.decode_route.route !== "direct-export" || requested.has(m.id)) continue;
    if (lacksWantedQuickProxy(m)) requestQuickProxy(m.id);
  }
}

export async function setProxyOverride(mediaId: string, value: boolean | null): Promise<void> {
  await updateProjectSettings({ proxy_override: { media_id: mediaId, value } });
  useProxyPrefStore.setState((s) => {
    const overrides = { ...s.overrides };
    if (value === null) delete overrides[mediaId];
    else overrides[mediaId] = value;
    return { overrides };
  });
}

async function rehydrate(): Promise<void> {
  const project = useProjectStore.getState().summary?.project_id;
  try {
    const v = await getProjectSettings();
    useProxyPrefStore.getState().hydrate({ preferProxies: v.prefer_proxies, overrides: v.proxy_overrides });
  } catch {
    // No project loaded yet — keep defaults.
    return;
  }
  // A project opened since has its own rehydrate coming.
  if (useProjectStore.getState().summary?.project_id !== project) return;
  hydratedProject = project;
  requestSkippedQuickProxies();
}

/** Hydrate on mount and re-hydrate whenever the project summary swaps
 *  (new project / reload). Call once from App.tsx; returns an unsubscribe. */
export function wireProxyPrefStore(): () => void {
  void rehydrate();
  return useProjectStore.subscribe((s, prev) => {
    // Compare project IDENTITY, not the summary object: `projectStore.apply()`
    // installs a brand-new `summary` object on every `project:changed` event
    // (every edit/undo/marker/MCP call), so comparing objects re-hydrates on
    // essentially every commit — a needless IPC round-trip, and a real
    // out-of-order-IPC race where an unrelated edit's in-flight rehydrate()
    // can resolve after a setProxyOverride/setPreferProxies optimistic write
    // and clobber it with a stale settings snapshot.
    if (s.summary?.project_id !== prev.summary?.project_id) {
      requested.clear();
      hydratedProject = undefined;
      void rehydrate();
    } else if (s.mediaById !== prev.mediaById) requestSkippedQuickProxies();
  });
}
