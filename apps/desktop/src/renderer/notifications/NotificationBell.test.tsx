// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "../i18n";
import type { AppSettings, AppSettingsPatch } from "../../shared/app-settings";
import { APP_SETTINGS_DEFAULTS } from "../../shared/app-settings";
import type { AppNotice } from "../../shared/ipc";
import type { Change } from "../../shared/review";
import type { UpdateStatus } from "../../shared/updates";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { NotificationBell } from "./NotificationBell";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
// No backend under jsdom: the review fetch answers nothing and keeps its view.
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
const mocks = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("../ipc", async (importOriginal) => ({ ...await importOriginal<object>(), appSettingsSet: mocks.set }));

/** How long a test waits for the screen to follow a status the app polls for
 * in real time. It only ends a wait for a poll that never comes. */
const STATUS_POLL_SEEN_MS = 10_000;

afterEach(async () => {
  cleanup();
  useAppSettingsStore.setState({ settings: APP_SETTINGS_DEFAULTS });
  const { resetReviewForTests } = await import("../agent/reviewStore");
  resetReviewForTests();
});

/// Main's side of the settings write, as far as the bell reads it back.
function setup(update: UpdateStatus = { phase: "current" }) {
  mocks.set.mockReset().mockImplementation(async (patch: AppSettingsPatch): Promise<AppSettings> => {
    const settings = useAppSettingsStore.getState().settings;
    return {
      ...settings,
      ...(patch.dismiss_notice ? { dismissed_notices: [...(settings.dismissed_notices ?? []), patch.dismiss_notice] } : {}),
      ...(patch.dismissed_update_version !== undefined ? { dismissed_update_version: patch.dismissed_update_version } : {}),
      ...(patch.skipped_update_version ? { skipped_update_version: patch.skipped_update_version } : {}),
    };
  });
  const updates = {
    status: vi.fn().mockResolvedValue(update),
    check: vi.fn().mockResolvedValue(update),
    download: vi.fn().mockResolvedValue("ready"),
    restart: vi.fn().mockResolvedValue("restarting"),
  };
  Object.assign(window, { api: { updates } });
  return updates;
}

function renderBell(notices: AppNotice[] = [], onOpenSettings = vi.fn()) {
  const view = render(<NotificationBell notices={notices} onOpenSettings={onOpenSettings} />);
  const bell = () => screen.getByTestId("status-bar-bell");
  const openCenter = () => {
    fireEvent.click(bell());
    return screen.getByRole("region", { name: "Needs attention" });
  };
  return { ...view, bell, openCenter, onOpenSettings };
}

const reviewWith = async (count: number) => {
  const { useReview } = await import("../agent/reviewStore");
  const change = (n: number): Change => ({ id: `Layer:${n}`, class: "added", details: [], composition_id: "r", ranges: [] });
  act(() => {
    useReview.getState().apply({
      version: { session: 1, revision: 1, baseline_revision: count + 1 }, content_revision: 1, has_baseline: true,
      unreviewed: Array.from({ length: count }, (_, n) => change(n)), user: [], user_count: 0, decorations: [],
    });
  });
};

describe("bell", () => {
  it.each([
    [[{ level: "info", code: "native_decode_unavailable" }], "info", "Needs attention: info"],
    [[{ level: "info", code: "native_decode_unavailable" }, { level: "warn", code: "keyring_unavailable" }], "warn", "Needs attention: warning"],
    [[{ level: "warn", code: "keyring_unavailable" }, { level: "error", code: "agent_skill_unavailable" }], "error", "Needs attention: error"],
  ] as const)("shows the most severe item's colour and names it: %j", async (notices, level, name) => {
    setup();
    const { bell } = renderBell([...notices]);
    await act(async () => {});
    expect(bell().dataset.level).toBe(level);
    expect(bell().getAttribute("aria-label")).toBe(name);
    expect(bell().querySelector(`.status-bell-dot.level-${level}`)).not.toBeNull();
  });

  it("carries no dot and says nothing needs attention when the list is empty", async () => {
    setup();
    const { bell, openCenter } = renderBell();
    await act(async () => {});
    expect(bell().dataset.level).toBe("none");
    expect(bell().getAttribute("aria-label")).toBe("Nothing needs attention");
    expect(bell().querySelector(".status-bell-dot")).toBeNull();
    expect(openCenter().textContent).toContain("Nothing needs attention");
  });
});

describe("notices", () => {
  it("dismisses a notice through app settings, out of the center and the dot, naming where it stays", async () => {
    setup();
    const { bell, openCenter } = renderBell([{ level: "warn", code: "keyring_unavailable" }]);
    await act(async () => {});
    const center = openCenter();
    const row = center.querySelector<HTMLElement>('[data-attention="notice:keyring_unavailable"]')!;
    expect(row.textContent).toContain("Cloud API keys aren't encrypted");
    const gotIt = within(row).getByRole("button", { name: "Got it" });
    // The state keeps a home; the link says which, before it is pressed.
    expect(gotIt.getAttribute("title")).toBe("Hides it here; it stays in Settings · Transcription");
    fireEvent.click(gotIt);
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ dismiss_notice: "keyring_unavailable" });

    await waitFor(() => expect(bell().dataset.level).toBe("none"));
    // No pile of dismissed rows: the center is simply empty again.
    expect(center.querySelector('[data-attention="notice:keyring_unavailable"]')).toBeNull();
    expect(center.textContent).toContain("Nothing needs attention");
  });

  it("opens the notice's settings page and closes the center", async () => {
    setup();
    const { openCenter, onOpenSettings } = renderBell([{ level: "error", code: "agent_skill_unavailable" }]);
    await act(async () => {});
    fireEvent.click(within(openCenter()).getByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("agent");
    expect(screen.queryByTestId("attention-center")).toBeNull();
  });
});

describe("agent changes to review", () => {
  it("opens the agent panel's Changes tab, and offers no dismissal", async () => {
    setup();
    const { useAgentActivity } = await import("../agent/activityStore");
    const { registerCommandProvider } = await import("../commands/registry");
    const open = vi.fn();
    const unregister = registerCommandProvider(() => [{ id: "openAgentPanel", run: open } as never]);
    useAgentActivity.setState({ tab: "activity" });
    const { bell, openCenter } = renderBell();
    await act(async () => {});
    await reviewWith(2);
    expect(bell().dataset.level).toBe("info");
    const row = openCenter().querySelector<HTMLElement>('[data-attention="review"]')!;
    expect(row.textContent).toContain("2 agent changes to review");
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Open review"]);
    fireEvent.click(within(row).getByRole("button", { name: "Open review" }));
    expect(useAgentActivity.getState().tab).toBe("changes");
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("attention-center")).toBeNull();
    unregister();
  });
});

describe("offered update", () => {
  it.each([
    [{ phase: "available", version: "1.2.0" }, "1.2.0 is available"],
    [{ phase: "downloading", version: "1.2.0", percent: 42 }, "Downloading 1.2.0… 42%"],
    [{ phase: "ready", version: "1.2.0" }, "1.2.0 is ready to install"],
    [{ phase: "error", version: "1.2.0" }, "Could not download 1.2.0"],
  ] as const)("names the %o phase in its row, without checking for updates", async (status, title) => {
    const updates = setup(status);
    const { bell, openCenter } = renderBell();
    await waitFor(() => expect(bell().dataset.level).toBe("info"));
    const row = openCenter().querySelector<HTMLElement>('[data-attention="update"]')!;
    expect(row.querySelector(".attention-row-title")!.textContent).toBe(title);
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("dismisses this version with Later", async () => {
    setup({ phase: "available", version: "1.2.0" });
    const { bell, openCenter } = renderBell();
    await waitFor(() => expect(bell().dataset.level).toBe("info"));
    const row = openCenter().querySelector<HTMLElement>('[data-attention="update"]')!;
    const later = within(row).getByRole("button", { name: "Later" });
    expect(later.getAttribute("title")).toBe("Hides it here; Help · Check for Updates still has it");
    fireEvent.click(later);
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ dismissed_update_version: "1.2.0" });
    await waitFor(() => expect(bell().dataset.level).toBe("none"));
  });

  it("opens the update dialog from its row, and the row goes once the version is skipped there", async () => {
    const updates = setup({ phase: "available", version: "1.2.0" });
    const { bell, openCenter } = renderBell();
    await waitFor(() => expect(bell().dataset.level).toBe("info"));
    const row = openCenter().querySelector<HTMLElement>('[data-attention="update"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "View" }));
    expect(screen.queryByTestId("attention-center")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Skip this version" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(bell().dataset.level).toBe("none"), { timeout: STATUS_POLL_SEEN_MS });
    expect(updates.download).not.toHaveBeenCalled();
  }, 2 * STATUS_POLL_SEEN_MS);
});
