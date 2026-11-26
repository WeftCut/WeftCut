// @vitest-environment jsdom
//
// The recents disclosure on the startup screen: a choice the user makes is
// remembered for the window's session (sessionStorage), so returning from the
// editor (which unmounts and remounts the screen) keeps it, while a fresh
// session opens collapsed. And Open project, which takes a pack too and whose
// unpack this screen shows itself: it has no work pill.
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
  projectOpen: vi.fn(),
  projectUnpack: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
/// What the screen hands the file-open requests hook on its latest render.
const fileOpen = vi.hoisted(() => ({ handle: null as ((file: string) => void) | null, ready: false }));

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
vi.mock("./fileOpenRequests", () => ({
  useFileOpenRequests: (handle: (file: string) => void, ready: boolean) => { fileOpen.handle = handle; fileOpen.ready = ready },
}));

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

describe("Open project", () => {
  it("says why a picked pack cannot be opened, and asks nothing more", async () => {
    const user = userEvent.setup();
    dialog.open.mockResolvedValueOnce("/home/u/in/notes.wcpk");
    ipc.projectUnpackInspect.mockRejectedValueOnce(new PackFailure({ refusal: "NotAPack", detail: "not a zip" }));
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    expect(await screen.findByText("That file isn't a WeftCut pack: not a zip")).toBeTruthy();
    expect(dialog.open).toHaveBeenCalledTimes(1);
  });

  it("shows the unpack's percent and bytes with Cancel", async () => {
    const user = userEvent.setup();
    await renderScreen();
    act(() => usePackJobStore.setState({ job: {
      job_id: "pack-1", kind: "unpack", file: "Example.wcpk", done: 1.5 * 1024 * 1024, total: 3 * 1024 * 1024, cancelling: false,
    } }));
    const progress = screen.getByRole("status", { name: "Unpacking Example.wcpk" });
    expect(progress.textContent).toContain("1.5 MB of 3.0 MB");
    expect(progress.textContent).not.toMatch(/left|remaining/i);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ipc.projectPackCancel).toHaveBeenCalled();
  });

  it("shows the unpack in place of Open project, not as a block of its own", async () => {
    await renderScreen();
    act(() => usePackJobStore.setState({ job: {
      job_id: "pack-1", kind: "unpack", file: "Example.wcpk", done: 1, total: 3, cancelling: false,
    } }));
    const progress = screen.getByRole("status", { name: "Unpacking Example.wcpk" });
    expect(progress.parentElement!.classList.contains("startup-actions")).toBe(true);
    expect(screen.queryByRole("button", { name: "Open project…" })).toBeNull();
  });

  // Main clears the run before it opens the unpacked folder.
  it("reads Opening once every byte is written, until the open settles", async () => {
    const user = userEvent.setup();
    let settle: (answer: unknown) => void = () => {};
    dialog.open.mockResolvedValueOnce("/home/u/in/Example.wcpk").mockResolvedValueOnce("/home/u/Projects");
    ipc.projectUnpackInspect.mockResolvedValueOnce({ name: "Example", folder_name: "Example", files: 3, bytes: 3 });
    ipc.projectUnpack.mockReturnValueOnce(new Promise((resolve) => { settle = resolve }));
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await vi.waitFor(() => expect(ipc.projectUnpack).toHaveBeenCalled());

    const run = { job_id: "pack-1", kind: "unpack", file: "Example.wcpk", done: 3, total: 3, cancelling: false } as const;
    act(() => usePackJobStore.setState({ job: run }));
    act(() => usePackJobStore.setState({ job: null }));
    expect(screen.getByRole("status", { name: "Unpacking Example.wcpk" }).textContent).toContain("Opening…");
    expect(screen.queryByRole("button", { name: "Open project…" })).toBeNull();

    await act(async () => settle({ outcome: "done", dir: "/home/u/Projects/Example" }));
    expect(screen.queryByRole("status", { name: "Unpacking Example.wcpk" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open project…" })).toBeTruthy();
  });

  it("goes back to Open project when the unpack is cancelled", async () => {
    const user = userEvent.setup();
    dialog.open.mockResolvedValueOnce("/home/u/in/Example.wcpk").mockResolvedValueOnce("/home/u/Projects");
    ipc.projectUnpackInspect.mockResolvedValueOnce({ name: "Example", folder_name: "Example", files: 3, bytes: 3 });
    ipc.projectUnpack.mockReturnValueOnce(new Promise(() => {}));
    await renderScreen();
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await vi.waitFor(() => expect(ipc.projectUnpack).toHaveBeenCalled());

    act(() => usePackJobStore.setState({ job: { job_id: "pack-1", kind: "unpack", file: "Example.wcpk", done: 3, total: 3, cancelling: true } }));
    act(() => usePackJobStore.setState({ job: null }));
    expect(screen.queryByRole("status", { name: "Unpacking Example.wcpk" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open project…" })).toBeTruthy();
  });
});

describe("a file the OS hands over", () => {
  it("waits while the picker is open, then opens as a picked file does", async () => {
    const user = userEvent.setup();
    const entered = vi.fn();
    let closePicker: (picked: string | null) => void = () => {};
    dialog.open.mockReturnValueOnce(new Promise((resolve) => { closePicker = resolve }));
    ipc.projectOpen.mockResolvedValue({ already_open: false });
    render(<StartupScreen onWorkspaceReady={entered} />);
    await screen.findByText(RECENTS[0]!.name);
    expect(fileOpen.ready).toBe(true);

    await user.click(screen.getByRole("button", { name: "Open project…" }));
    expect(fileOpen.ready, "the screen took a request while its picker was open").toBe(false);
    await act(async () => closePicker(null));
    expect(fileOpen.ready).toBe(true);

    await act(async () => fileOpen.handle!("/home/u/Videos/Trip/project.wcpr"));
    expect(ipc.projectOpen).toHaveBeenCalledWith("/home/u/Videos/Trip/project.wcpr", true);
    expect(entered).toHaveBeenCalledOnce();
  });
});
