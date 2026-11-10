// @vitest-environment jsdom
//
// The recents disclosure on the startup screen: a choice the user makes is
// remembered for the window's session (sessionStorage), so returning from the
// editor (which unmounts and remounts the screen) keeps it, while a fresh
// session opens collapsed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});
// Chrome around the list reaches `window.api`, which jsdom does not have.
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../menu/nativeMenu", () => ({ useNativeMenu: () => {} }));
vi.mock("../components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../app/UpdateButton", () => ({ UpdateButton: () => null }));

import "../i18n";
import { StartupScreen } from "./StartupScreen";

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

afterEach(cleanup);

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
