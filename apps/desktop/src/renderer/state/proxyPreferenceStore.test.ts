import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProjectSettings = vi.fn();
const generateQuickProxy = vi.fn();
vi.mock("../ipc", () => ({
  getProjectSettings: (...a: unknown[]) => getProjectSettings(...a),
  updateProjectSettings: vi.fn(),
  generateQuickProxy: (...a: unknown[]) => generateQuickProxy(...a),
}));

import { useProxyPrefStore, proxyIntent, setPreferProxies, wireProxyPrefStore } from "./proxyPreferenceStore";
import { useProjectStore } from "./projectStore";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { APP_SETTINGS_DEFAULTS } from "../../shared/app-settings";
import type { MediaSummary, ProjectSummary } from "../ipc";
import { summaryFixture } from "../testing/summaryFixture";

// Minimal summary — only project_id is read by the code under test.
function summaryWithId(project_id: string): ProjectSummary {
  return summaryFixture({ project_id, name: "p" });
}

/** A hashed, present 4K H.264 clip whose route decision chose DirectExport
 *  and whose quick proxy is not built. */
function directExport(id: string, over: Partial<MediaSummary> = {}): MediaSummary {
  return {
    id, label: id, path: `/media/${id}.mp4`, kind: "Video", duration_us: 1_000_000,
    width: 3840, height: 2160, size_bytes: 1024, content_hash: "a".repeat(64), available: true,
    decode_route: { route: "direct-export", quick_proxy: null }, codec: "h264", pix_fmt: "yuv420p",
    ...over,
  };
}

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe("proxyPreferenceStore", () => {
  beforeEach(() => {
    useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
    useProjectStore.getState().apply(null);
    useProjectStore.setState({ summary: null, ready: false });
    useAppSettingsStore.setState({ settings: APP_SETTINGS_DEFAULTS });
    getProjectSettings.mockReset();
    getProjectSettings.mockResolvedValue({ prefer_proxies: false, proxy_overrides: {} });
    generateQuickProxy.mockReset();
    generateQuickProxy.mockResolvedValue(undefined);
  });

  it("proxyIntent follows the global toggle when no override is set", () => {
    useProxyPrefStore.setState({ preferProxies: true, overrides: {} });
    expect(proxyIntent("m1")).toBe(true);
  });

  it("a per-clip override wins over the global toggle", () => {
    useProxyPrefStore.setState({ preferProxies: true, overrides: { m1: false } });
    expect(proxyIntent("m1")).toBe(false);
    useProxyPrefStore.setState({ preferProxies: false, overrides: { m1: true } });
    expect(proxyIntent("m1")).toBe(true);
  });

  describe("wireProxyPrefStore", () => {
    // Always torn down, even on assertion failure, so a failing test never
    // leaks its subscription into the next one.
    let unwire: (() => void) | null = null;
    afterEach(() => {
      unwire?.();
      unwire = null;
    });

    it("does NOT re-hydrate when the summary object changes but project_id stays the same (same-project edit)", async () => {
      // Seed a loaded project BEFORE wiring, so the mount hydrate is the
      // only call attributable to setup, not to a project_id transition.
      useProjectStore.setState({ summary: summaryWithId("proj-1"), ready: true });
      unwire = wireProxyPrefStore();
      // Flush the initial mount hydrate.
      await Promise.resolve();
      await Promise.resolve();
      expect(getProjectSettings).toHaveBeenCalledTimes(1);

      // Simulate projectStore.apply() installing a brand-new summary object
      // for the SAME project (e.g. an edit/undo/marker commit) — same
      // project_id, new object identity.
      useProjectStore.setState({ summary: summaryWithId("proj-1") });
      useProjectStore.setState({ summary: summaryWithId("proj-1") });
      await Promise.resolve();
      await Promise.resolve();

      expect(getProjectSettings).toHaveBeenCalledTimes(1);
    });

    it("DOES re-hydrate when project_id changes (genuine project swap / reload)", async () => {
      unwire = wireProxyPrefStore();
      await Promise.resolve();
      await Promise.resolve();
      expect(getProjectSettings).toHaveBeenCalledTimes(1);

      useProjectStore.setState({ summary: summaryWithId("proj-1") });
      await Promise.resolve();
      await Promise.resolve();
      expect(getProjectSettings).toHaveBeenCalledTimes(2);

      useProjectStore.setState({ summary: summaryWithId("proj-2") });
      await Promise.resolve();
      await Promise.resolve();
      expect(getProjectSettings).toHaveBeenCalledTimes(3);
    });
  });

  describe("setPreferProxies", () => {
    it("turning it on asks for each missing quick proxy a clip would preview", async () => {
      useProjectStore.getState().apply(summaryFixture({
        project_id: "p-toggle", name: "p",
        media: [
          directExport("m-missing"),
          // Skipped, one reason each:
          directExport("m-bypass", { decode_route: { route: "bypass" } }),
          directExport("m-ready", { decode_route: { route: "direct-export", quick_proxy: "/proxies/m-ready.mp4" } }),
          directExport("m-pinned"),
          directExport("m-image", { kind: "Image" }),
          directExport("m-hashing", { content_hash: null }),
          directExport("m-offline", { available: false }),
        ],
      }));
      useProxyPrefStore.setState({ overrides: { "m-pinned": false } });

      await setPreferProxies(true);
      expect(generateQuickProxy.mock.calls).toEqual([["m-missing"]]);

      generateQuickProxy.mockClear();
      await setPreferProxies(false);
      expect(generateQuickProxy).not.toHaveBeenCalled();
    });
  });

  describe("a quick proxy the import left out", () => {
    let unwire: (() => void) | null = null;
    afterEach(() => {
      unwire?.();
      unwire = null;
    });
    const importOff = () =>
      useAppSettingsStore.setState({ settings: { ...APP_SETTINGS_DEFAULTS, build_quick_proxies_on_import: false } });
    const land = (project_id: string, media: MediaSummary[]) =>
      useProjectStore.getState().apply(summaryFixture({ project_id, name: "p", media }));

    it("is asked for once when a clip that previews from proxy gets its route", async () => {
      importOff();
      getProjectSettings.mockResolvedValue({ prefer_proxies: true, proxy_overrides: {} });
      unwire = wireProxyPrefStore();
      // Added on the placeholder route, before its decision: nothing to ask yet.
      land("p-route", [directExport("m1", { decode_route: { route: "proxied", quick_proxy: null, full_proxy: null } })]);
      await flush();
      expect(generateQuickProxy).not.toHaveBeenCalled();

      land("p-route", [directExport("m1")]);
      land("p-route", [directExport("m1")]);
      expect(generateQuickProxy.mock.calls).toEqual([["m1"]]);
    });

    it("is asked for when a project opens with the clip previewing from proxy", async () => {
      importOff();
      getProjectSettings.mockResolvedValue({ prefer_proxies: false, proxy_overrides: { m1: true } });
      unwire = wireProxyPrefStore();
      land("p-open", [directExport("m1"), directExport("m2")]);
      await flush();
      expect(generateQuickProxy.mock.calls).toEqual([["m1"]]);
    });

    it("is not asked for while the import builds it", async () => {
      getProjectSettings.mockResolvedValue({ prefer_proxies: true, proxy_overrides: {} });
      unwire = wireProxyPrefStore();
      land("p-on", [directExport("m1")]);
      await flush();
      land("p-on", [directExport("m1")]);
      expect(generateQuickProxy).not.toHaveBeenCalled();
    });
  });
});
