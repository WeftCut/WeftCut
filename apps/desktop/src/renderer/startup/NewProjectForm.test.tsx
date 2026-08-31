// @vitest-environment jsdom
//
// Covers the New Project dialog's canvas half (exported from StartupScreen.tsx):
// resolution and frame rate as two independent choices, the custom width/height
// pair behind the "Custom" entry, and the size rule gating Create. The point of
// the split is combinations the old single-preset list could not express — 4K at
// 25 fps, or a vertical canvas — so those are what the cases create.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  projectNewWorkspace: vi.fn(),
  recentsLastNewProjectParent: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});
// The form asks for a fallback parent folder on mount; both bridges reach through
// `window.api`, which does not exist under jsdom.
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/bridge/path", () => ({
  documentDir: vi.fn(async () => "C:\\Docs"),
  join: vi.fn(),
  tempDir: vi.fn(),
}));

import i18n from "../i18n";
import { NewProjectForm } from "./StartupScreen";

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

const onCancel = vi.fn();
const onCreated = vi.fn();

/// Create stays inert until the dialog has a legal name AND a parent folder, so
/// every case that reaches the button fills the name in first. The parent arrives
/// on its own from the mocked recents lookup.
async function renderForm(user: ReturnType<typeof userEvent.setup>) {
  render(<NewProjectForm onCancel={onCancel} onCreated={onCreated} />);
  await waitFor(() => expect(screen.getByText("C:\\Projects")).toBeTruthy());
  await user.type(screen.getByLabelText("Project name"), "Demo");
}

/// Open a Base UI Select by keyboard, NOT `user.click`: a click on the trigger
/// opens the popup only for the first Select touched in a given test file — every
/// later one leaves it `aria-expanded="false"` and the assertions silently look at
/// a closed popup.
async function openSelect(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = screen.getByRole("combobox", { name });
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  return trigger;
}

async function pickOption(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.pointer({
    target: screen.getByRole("option", { name: label }),
    keys: "[MouseLeft]",
  });
}

/// Base UI's NumberField appends to whatever is already there, so clear first.
async function typeSize(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
}

function createButton() {
  return screen.getByRole("button", { name: "Create" });
}

// Base UI's Select portals its popup outside the render container, so drop
// whatever `cleanup()` leaves on the body before the next test queries roles.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onCancel.mockReset();
  onCreated.mockReset();
  ipc.projectNewWorkspace.mockReset().mockResolvedValue("C:\\Projects\\Demo");
  ipc.recentsLastNewProjectParent.mockReset().mockResolvedValue("C:\\Projects");
});

describe("NewProjectForm canvas", () => {
  it("opens on the shared default pair, not on Custom", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    expect(screen.getByRole("combobox", { name: "Resolution" }).textContent).toContain(
      "1920 × 1080",
    );
    expect(screen.getByRole("combobox", { name: "Frame rate" }).textContent).toContain("60 fps");
    // The default is on the ladder, so the custom fields stay out of the way.
    expect(screen.queryByLabelText("Width")).toBeNull();
  });

  /// The whole reason for the split: 4K at 25 fps was not a preset, so it was not
  /// creatable at all — the user had to make a 4K30 project and then change the
  /// rate in Settings before touching the timeline.
  it("creates a combination the single preset list could not express", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "3840 × 2160");
    await openSelect(user, "Frame rate");
    await pickOption(user, "25 fps (PAL)");
    await user.click(createButton());

    await waitFor(() => expect(ipc.projectNewWorkspace).toHaveBeenCalledTimes(1));
    expect(ipc.projectNewWorkspace).toHaveBeenCalledWith({
      parentFolder: "C:\\Projects",
      name: "Demo",
      canvas: { width: 3840, height: 2160, fpsNum: 25, fpsDen: 1 },
    });
  });

  it("sends the exact rational, not the rounded label", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Frame rate");
    await pickOption(user, "29.97 fps (NTSC)");
    await user.click(createButton());

    await waitFor(() => expect(ipc.projectNewWorkspace).toHaveBeenCalledTimes(1));
    expect(ipc.projectNewWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: { width: 1920, height: 1080, fpsNum: 30_000, fpsDen: 1001 },
      }),
    );
  });

  /// The ladder is 16:9 only, so a vertical project — the short-form case — is
  /// exactly what "Custom" is for. It was unreachable at creation time before.
  it("creates a vertical canvas through Custom", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    await typeSize(user, "Width", "1080");
    await typeSize(user, "Height", "1920");
    await user.click(createButton());

    await waitFor(() => expect(ipc.projectNewWorkspace).toHaveBeenCalledTimes(1));
    expect(ipc.projectNewWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: { width: 1080, height: 1920, fpsNum: 60, fpsDen: 1 },
      }),
    );
  });

  it("hides the size fields until Custom is chosen, and creates nothing on its own", async () => {
    const user = userEvent.setup();
    await renderForm(user);
    expect(screen.queryByLabelText("Width")).toBeNull();

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    expect(screen.getByLabelText("Width")).toBeTruthy();
    expect(screen.getByLabelText("Height")).toBeTruthy();
    expect(ipc.projectNewWorkspace).not.toHaveBeenCalled();
  });

  it("picking a preset leaves custom mode", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    await openSelect(user, "Resolution");
    await pickOption(user, "1280 × 720");

    expect(screen.queryByLabelText("Width")).toBeNull();
  });
});

/// Same rule as Settings › Canvas, from the same validator — but with no Apply
/// button to hold a bad size back, an invalid size has to gate Create.
describe("NewProjectForm custom size validation", () => {
  it("blocks Create on an odd dimension rather than letting export shave a pixel", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    await typeSize(user, "Width", "1921");

    expect(screen.getByRole("alert").textContent).toContain("even numbers");
    expect(createButton().hasAttribute("disabled")).toBe(true);
  });

  it("blocks Create past the 8K ceiling", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    await typeSize(user, "Width", "9000");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(createButton().hasAttribute("disabled")).toBe(true);
  });

  it("blocks Create below the floor", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    await typeSize(user, "Height", "8");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(createButton().hasAttribute("disabled")).toBe(true);
  });

  /// Leaving Custom for a ladder entry has to clear the fault too — otherwise a
  /// size the user has already abandoned would keep Create switched off.
  it("clears the fault when a preset replaces the bad size", async () => {
    const user = userEvent.setup();
    await renderForm(user);

    await openSelect(user, "Resolution");
    await pickOption(user, "Custom");
    await typeSize(user, "Width", "1921");
    expect(createButton().hasAttribute("disabled")).toBe(true);

    await openSelect(user, "Resolution");
    await pickOption(user, "1920 × 1080");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(createButton().hasAttribute("disabled")).toBe(false);
  });
});
