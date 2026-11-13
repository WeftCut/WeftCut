// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useStatusPopover } from "./useStatusPopover";

// jsdom has no PointerEvent; the outside-press listener only needs the target.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

function Popover({ name }: { name: string }) {
  const { open, rootRef, detailsId, triggerProps } = useStatusPopover();
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
    screen.getByRole("button", { name: "Bell action" }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(details("Bell")).toBeNull();
    expect(document.activeElement).toBe(trigger("Bell"));
  });
});
