// @vitest-environment jsdom
//
// The recents disclosure on the startup screen: a choice the user makes is
// remembered for the window's session (sessionStorage), so returning from the
// editor (which unmounts and remounts the screen) keeps it, while a fresh
// session opens collapsed. And Open packed project, whose unpack this screen
// shows itself: it has no work pill.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RecentEntry } from "../ipc";

const RECENTS: RecentEntry[] = Array.from({ length: 6 }, (_, i) => ({
  path: `/home/u/Videos/Project ${i}`,
  name: `Project ${i}`,
  last_opened: "2026-01-01T00:00:00.000Z",
}));

const ipc = vi.hoisted(() => ({
  recentsList: vi.fn(),
  keybindingsGet: vi.fn(async () => ({})),
  projectUnpackInspect: vi.fn(),
  projectPackCancel: vi.fn(async () => true),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});
// Chrome around the list reaches `window.api`, which jsdom does not have.
vi.mock("@/bridge/dialog", () => ({ open: dialog.open, save: vi.fn() }));
vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../menu/nativeMenu", () => ({ useNativeMenu: () => {} }));
vi.mock("../components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../app/UpdateButton", () => ({ UpdateButton: () => null }));

import "../i18n";
import { StartupScreen } from "./StartupScreen";
import { usePackJobStore } from "../pack/packJobStore";
import { PackFailure } from "../../shared/projectPack";

/// Renders the screen and waits for the recents to load; returns the toggle.
async function renderScreen(): Promise<HTMLElement> {
  render(<StartupScreen onWorkspaceReady={() => {}} />);
  await screen.findByText(RECENTS[0]!.name);
  return document.querySelector<HTMLElement>(".startup-recent-toggle")!;
}

function shownProjects(): string[] {
  return [...document.querySelectorAll(".startup-recent-name")].map(
    (el) => el.textContent ?? "",
  );
}

beforeEach(() => {
  sessionStorage.clear();
  ipc.recentsList.mockResolvedValue(RECENTS);
});

afterEach(() => {
  cleanup();
  usePackJobStore.setState({ job: null });
  dialog.open.mockReset();
});

describe("recents disclosure", () => {
  it("opens collapsed in a fresh session", async () => {
    const toggle = await renderScreen();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(shownProjects().length).toBeLessThan(RECENTS.length);
  });

  it("keeps the user's expansion across a remount in the same session", async () => {
    const user = userEvent.setup();
    await user.click(await renderScreen());
    expect(shownProjects()).toHaveLength(RECENTS.length);

    cleanup();
    const toggle = await renderScreen();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(shownProjects()).toHaveLength(RECENTS.length);
  });

  it("keeps a collapse made after expanding", async () => {
    const user = userEvent.setup();
    const toggle = await renderScreen();
    await user.click(toggle);
    await user.click(toggle);

    cleanup();
    expect((await renderScreen()).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Open packed project", () => {
  it("says why the picked file cannot be opened, and asks nothing more", async () => {
    const user = userEvent.setup();
    dialog.open.mockResolvedValueOnce("/home/u/in/notes.weftcut");
    ipc.projectUnpackInspect.mockRejectedValueOnce(new PackFailure({ refusal: "NotAPack", detail: "not a zip" }));
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Open packed project…" }));
    expect(await screen.findByText("That file isn't a WeftCut pack: not a zip")).toBeTruthy();
    expect(dialog.open).toHaveBeenCalledTimes(1);
  });

  it("shows the unpack's percent and bytes with Cancel", async () => {
    const user = userEvent.setup();
    await renderScreen();
    act(() => usePackJobStore.setState({ job: {
      job_id: "pack-1", kind: "unpack", file: "Example.weftcut", done: 1.5 * 1024 * 1024, total: 3 * 1024 * 1024, cancelling: false,
    } }));
    const progress = screen.getByRole("status", { name: "Unpacking Example.weftcut" });
    expect(progress.textContent).toContain("1.5 MB of 3.0 MB");
    expect(progress.textContent).not.toMatch(/left|remaining/i);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ipc.projectPackCancel).toHaveBeenCalled();
  });
});
