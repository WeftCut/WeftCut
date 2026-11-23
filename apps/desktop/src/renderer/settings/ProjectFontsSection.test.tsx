// @vitest-environment jsdom
//
// Settings > Project > Fonts: what the section offers from main's view, and
// which projectFonts call each control makes. The IPC wrappers are stubbed;
// `changed` fires main's `project-fonts:changed` event by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ProjectFontsView } from "../ipc";

const ipc = vi.hoisted(() => ({
  projectFontsView: vi.fn(),
  projectFontsExclude: vi.fn(),
  projectFontsAllow: vi.fn(),
  onProjectFontsChanged: vi.fn(),
}));
const changed = vi.hoisted(() => ({ fire: null as null | (() => void) }));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  ...ipc,
}));
const shell = vi.hoisted(() => ({ reveal: vi.fn(), open: vi.fn() }));
vi.mock("@/bridge/shell", () => shell);

import i18n from "../i18n";
import { ProjectFontsSection } from "./ProjectFontsSection";

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

const VIEW: ProjectFontsView = {
  dir: "/home/u/Projects/Demo/Fonts",
  copied: [
    { family: "Inter", files: 2, bytes: 600_000 },
    { family: "Noto Serif", files: 1, bytes: 300_000 },
  ],
  excluded: [
    { family: "Brand Sans", installed: true },
    { family: "Elsewhere Grotesk", installed: false },
  ],
};

const onError = vi.fn();

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onError.mockReset();
  ipc.projectFontsView.mockReset().mockResolvedValue(VIEW);
  ipc.projectFontsExclude.mockReset().mockResolvedValue(VIEW);
  ipc.projectFontsAllow.mockReset().mockResolvedValue(VIEW);
  ipc.onProjectFontsChanged.mockReset().mockImplementation((cb: () => void) => {
    changed.fire = cb;
    return () => { changed.fire = null; };
  });
  shell.reveal.mockReset().mockResolvedValue(undefined);
});

async function renderSection() {
  render(<ProjectFontsSection onError={onError} />);
  await waitFor(() => expect(screen.getByText(/2 font families copied/)).toBeTruthy());
}

/// Keyboard, not a click: see NewProjectForm.test.tsx's `openSelect`.
async function openAddExclusion(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("combobox", { name: "Add exclusion" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
}

describe("ProjectFontsSection", () => {
  it("lists excluded families installed here and hides the rest", async () => {
    await renderSection();
    const excluded = screen.getByRole("group", { name: "Excluded fonts" });
    expect(within(excluded).getByText("Brand Sans")).toBeTruthy();
    expect(within(excluded).queryByText("Elsewhere Grotesk")).toBeNull();
  });

  it("allows copying an excluded family again", async () => {
    const user = userEvent.setup();
    await renderSection();
    const excluded = screen.getByRole("group", { name: "Excluded fonts" });
    await user.click(within(excluded).getByRole("button", { name: "Allow copying" }));
    expect(ipc.projectFontsAllow).toHaveBeenCalledWith("Brand Sans");
  });

  it("offers only copied families for exclusion and excludes the one chosen", async () => {
    const user = userEvent.setup();
    await renderSection();
    await openAddExclusion(user);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      expect.stringContaining("Inter · 2 files"),
      expect.stringContaining("Noto Serif · 1 file"),
    ]);
    await user.pointer({ target: screen.getByRole("option", { name: /Noto Serif/ }), keys: "[MouseLeft]" });
    expect(ipc.projectFontsExclude).toHaveBeenCalledWith("Noto Serif");
  });

  it("leaves nothing to exclude or show when no font is copied", async () => {
    ipc.projectFontsView.mockResolvedValue({ ...VIEW, copied: [] });
    render(<ProjectFontsSection onError={onError} />);
    await waitFor(() => expect(screen.getByText("No fonts copied yet")).toBeTruthy());
    expect(screen.getByRole("combobox", { name: "Add exclusion" }).hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Show in folder" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the project's Fonts/ folder", async () => {
    const user = userEvent.setup();
    await renderSection();
    await user.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(shell.reveal).toHaveBeenCalledWith(VIEW.dir);
  });

  it("reads the view again when main says it changed", async () => {
    await renderSection();
    ipc.projectFontsView.mockResolvedValue({ ...VIEW, copied: [VIEW.copied[0]!] });
    await act(async () => changed.fire!());
    await waitFor(() => expect(screen.getByText(/1 font family copied/)).toBeTruthy());
  });
});
