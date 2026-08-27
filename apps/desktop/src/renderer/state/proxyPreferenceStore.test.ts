import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProjectSettings = vi.fn();
vi.mock("../ipc", () => ({
  getProjectSettings: (...a: unknown[]) => getProjectSettings(...a),
  updateProjectSettings: vi.fn(),
}));

import { useProxyPrefStore, proxyIntent, wireProxyPrefStore } from "./proxyPreferenceStore";
import { useProjectStore } from "./projectStore";
import type { ProjectSummary } from "../ipc";
import { summaryFixture } from "../testing/summaryFixture";

// Minimal summary — only project_id is read by the code under test.
function summaryWithId(project_id: string): ProjectSummary {
  return summaryFixture({ project_id, name: "p" });
}

describe("proxyPreferenceStore", () => {
  beforeEach(() => {
    useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
    useProjectStore.setState({ summary: null, ready: false });
    getProjectSettings.mockReset();
    getProjectSettings.mockResolvedValue({ prefer_proxies: false, proxy_overrides: {} });
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
});
