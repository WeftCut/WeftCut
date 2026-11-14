// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useStatusPopover } from "./useStatusPopover";

// jsdom has no PointerEvent; the outside-press listener only needs the target.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

/// `present` stands for the state the trigger reports (work running, a save
/// failing): without it the component renders nothing, as the real ones do.
function Popover({ name, present = true }: { name: string; present?: boolean }) {
  const { open, rootRef, detailsId, triggerProps } = useStatusPopover();
  if (!present) return null;
  return (
    <div ref={rootRef}>
      <button type="button" {...triggerProps}>{name}</button>
      {open && <section id={detailsId} aria-label={`${name} details`}><button type="button">{`${name} action`}</button></section>}
    </div>
  );
}

function renderTwo() {
  render(
    <>
      <button type="button">Elsewhere</button>
      <Popover name="Work" />
      <Popover name="Bell" />
    </>,
  );
  const trigger = (name: string) => screen.getByRole("button", { name });
  const details = (name: string) => screen.queryByRole("region", { name: `${name} details` });
  return { trigger, details };
}

afterEach(cleanup);

describe("useStatusPopover", () => {
  it("toggles from its trigger and points the trigger at what it opened", () => {
    const { trigger, details } = renderTwo();
    expect(trigger("Work").getAttribute("aria-expanded")).toBe("false");
    expect(trigger("Work").hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(trigger("Work"));
    expect(trigger("Work").getAttribute("aria-expanded")).toBe("true");
    expect(trigger("Work").getAttribute("aria-controls")).toBe(details("Work")!.id);
    fireEvent.click(trigger("Work"));
    expect(details("Work")).toBeNull();
  });

  it("keeps one open at a time: opening the second closes the first, by keyboard too", () => {
    const { trigger, details } = renderTwo();
    fireEvent.click(trigger("Work"));
    // A click with no pointer press before it, as Enter or Space on the
    // trigger delivers: the outside-press close never runs.
    fireEvent.click(trigger("Bell"));
    expect(details("Bell")).not.toBeNull();
    expect(details("Work")).toBeNull();
    expect(trigger("Work").getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a press outside, and stays open for a press inside", () => {
    const { trigger, details } = renderTwo();
    fireEvent.click(trigger("Work"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Work action" }));
    expect(details("Work")).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(details("Work")).toBeNull();
  });

  it("closes on Escape and hands focus back to its trigger", () => {
    const { trigger, details } = renderTwo();
    fireEvent.click(trigger("Bell"));
    const action = screen.getByRole("button", { name: "Bell action" });
    action.focus();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(details("Bell")).toBeNull();
    expect(document.activeElement).toBe(trigger("Bell"));
  });

  it("owns the Escape that closes it: the editor's own Escape does not also run", () => {
    const editorEscape = vi.fn();
    window.addEventListener("keydown", editorEscape);
    try {
      const { trigger, details } = renderTwo();
      fireEvent.click(trigger("Bell"));
      fireEvent.keyDown(trigger("Bell"), { key: "Escape" });
      expect(details("Bell")).toBeNull();
      expect(editorEscape).not.toHaveBeenCalled();
      // Closed, Escape is the editor's again.
      fireEvent.keyDown(trigger("Bell"), { key: "Escape" });
      expect(editorEscape).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", editorEscape);
    }
  });

  it("leaves focus where the user moved it", () => {
    const { trigger, details } = renderTwo();
    fireEvent.click(trigger("Work"));
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(details("Work")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("leaves Escape to a dialog that holds focus", () => {
    render(
      <>
        <Popover name="Work" />
        <div role="dialog" aria-label="Settings"><button type="button">Inside dialog</button></div>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Inside dialog" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Work details" })).not.toBeNull();
  });

  it("closes with its trigger, and does not come back open when the trigger returns", () => {
    const { rerender } = render(<Popover name="Work" present />);
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.queryByRole("region", { name: "Work details" })).not.toBeNull();
    rerender(<Popover name="Work" present={false} />);
    rerender(<Popover name="Work" present />);
    expect(screen.getByRole("button", { name: "Work" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Work details" })).toBeNull();
  });
});
