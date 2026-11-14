// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";
import { receiveSaveStatus, useSaveStatusStore } from "../state/saveStatusStore";
import { NotSavedPill, type SaveFailureActions } from "./NotSavedPill";

let revision = 0;
const fail = (code: string | null, last_saved_at: string | null = null) =>
  act(() => receiveSaveStatus({
    state: "failing", revision: ++revision, since: "2026-01-02T03:04:05.000Z", last_saved_at,
    code, path: "/home/u/Projects/Demo/project.json", dir: "/home/u/Projects/Demo",
  }));
const recover = () => act(() => receiveSaveStatus({ state: "ok", revision: ++revision }));
const actions = (over: Partial<SaveFailureActions> = {}): SaveFailureActions => ({
  retry: vi.fn(async () => {}),
  saveAs: vi.fn(),
  openFolder: vi.fn(async (_dir: string) => {}),
  ...over,
});
const pill = () => screen.queryByTestId("not-saved-pill");
const details = () => screen.queryByTestId("not-saved-details");

afterEach(() => {
  cleanup();
  useSaveStatusStore.setState({ status: { state: "ok", revision: 0 } });
  revision = 0;
});

describe("NotSavedPill", () => {
  it("is absent while saving works, and comes and goes with the failing state", () => {
    render(<NotSavedPill actions={actions()} />);
    expect(pill()).toBeNull();
    fail("ENOSPC");
    expect(pill()!.textContent).toBe("Not saved");
    expect(pill()!.getAttribute("aria-label")).toBe("Not saved: The disk is full.");
    // The reason and the last good save show on hover, without opening it.
    expect(pill()!.getAttribute("title")).toBe("The disk is full.\nNot saved since the project was opened");
    recover();
    expect(pill()).toBeNull();
  });

  it("leads its popover with the reason, then the body, the last save and the folder, a line each", () => {
    render(<NotSavedPill actions={actions()} />);
    fail("ENOSPC");
    fireEvent.click(pill()!);
    expect(pill()!.getAttribute("aria-expanded")).toBe("true");
    const lines = [...details()!.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual([
      "The disk is full.",
      "Recent edits are not on disk yet. WeftCut keeps trying to save them.",
      "Not saved since the project was opened",
      "Project folder: /home/u/Projects/Demo",
    ]);
  });

  it("opens below its trigger in the agent titlebar", () => {
    render(<NotSavedPill actions={actions()} placement="down" />);
    fail("EACCES");
    fireEvent.click(pill()!);
    expect(details()!.classList).toContain("is-below");
  });

  it("retries: says it is saving, and a success takes the pill and popover away", async () => {
    let finish!: () => void;
    const retry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<NotSavedPill actions={actions({ retry })} />);
    fail("ENOSPC");
    fireEvent.click(pill()!);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(true);
    // Main reports the save through the status stream; the retry then settles.
    recover();
    await act(async () => { finish(); });
    expect(pill()).toBeNull();
    expect(details()).toBeNull();
  });

  it("says when a retry fails again, and lets it be tried once more", async () => {
    const retry = vi.fn(async () => { throw new Error("ENOSPC"); });
    render(<NotSavedPill actions={actions({ retry })} />);
    fail("ENOSPC");
    fireEvent.click(pill()!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry now" })); });
    expect(screen.getByRole("status").textContent).toBe("Still not saved.");
    expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(false);
    expect(pill()).not.toBeNull();
  });

  it("hands over to Save As, closing the popover for its dialog", () => {
    const saveAs = vi.fn();
    render(<NotSavedPill actions={actions({ saveAs })} />);
    fail("ENOSPC");
    fireEvent.click(pill()!);
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    expect(saveAs).toHaveBeenCalledOnce();
    expect(details()).toBeNull();
    expect(pill()).not.toBeNull();
  });

  it("opens the project folder, and says so when it cannot", async () => {
    const openFolder = vi.fn(async (_dir: string) => { throw new Error("no file manager"); });
    render(<NotSavedPill actions={actions({ openFolder })} />);
    fail("ENOENT");
    fireEvent.click(pill()!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open folder" })); });
    expect(openFolder).toHaveBeenCalledExactlyOnceWith("/home/u/Projects/Demo");
    expect(screen.getByRole("status").textContent).toBe("Could not open the folder: Error: no file manager");
    expect(details()).not.toBeNull();
  });

  it("does not come back open when saving fails again after a recovery", () => {
    render(<NotSavedPill actions={actions()} />);
    fail("ENOSPC");
    fireEvent.click(pill()!);
    expect(details()).not.toBeNull();
    recover();
    fail("EACCES");
    expect(pill()!.getAttribute("aria-expanded")).toBe("false");
    expect(details()).toBeNull();
  });
});
