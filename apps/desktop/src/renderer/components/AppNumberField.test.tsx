// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppNumberField } from "./AppNumberField";

afterEach(cleanup);

// Call sites like font_size / speed mirror the typed value into `value` via
// onValueChange (so the controlled input follows typing). The debounced
// auto-commit must still fire for them — the dedup guard must not mistake the
// mirrored value for an already-committed one.
function Mirrored({ onCommit }: { onCommit: (n: number) => void }) {
  const [v, setV] = useState(0);
  return <AppNumberField value={v} onValueChange={setV} onCommit={onCommit} ariaLabel="x" />;
}

describe("AppNumberField", () => {
  it("emits live numeric changes via onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppNumberField value={0} onValueChange={onValueChange} ariaLabel="x" />);
    await userEvent.type(screen.getByLabelText("x"), "5");
    expect(onValueChange).toHaveBeenLastCalledWith(5);
  });

  it("fires onCommit on blur, not on every keystroke", async () => {
    const onCommit = vi.fn();
    render(<AppNumberField value={0} onValueChange={() => {}} onCommit={onCommit} ariaLabel="x" />);
    const el = screen.getByLabelText("x");
    await userEvent.type(el, "12");
    expect(onCommit).not.toHaveBeenCalled();
    // Click outside to blur through the full event chain (more faithful than
    // a raw el.blur()): exercises Base UI's inputBlur commit path.
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledWith(12);
    // (Enter-to-commit also goes through onValueCommitted, but jsdom doesn't
    // drive Base UI's keyboard commit path.)
  });

  // Real timers throughout: fake ones do not drive Base UI's inputBlur commit.
  // The debounce's length is tuning; these tests wait for its commit.
  const committed = (onCommit: ReturnType<typeof vi.fn>, value: number) =>
    vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith(value), { timeout: 10_000 });

  it("auto-commits the typed value after the debounce window, not before", async () => {
    const onCommit = vi.fn();
    render(<AppNumberField value={0} onValueChange={() => {}} onCommit={onCommit} ariaLabel="x" />);
    await userEvent.type(screen.getByLabelText("x"), "12");
    // No keystroke commits by itself; the debounce does, once, with the whole value.
    expect(onCommit).not.toHaveBeenCalled();
    await committed(onCommit, 12);
    expect(onCommit).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("auto-commits when the call site mirrors the value via onValueChange", async () => {
    const onCommit = vi.fn();
    render(<Mirrored onCommit={onCommit} />);
    await userEvent.type(screen.getByLabelText("x"), "7");
    await committed(onCommit, 7);
  }, 20_000);

  it("does not re-commit on blur after a debounced commit (dedup guard)", async () => {
    const onCommit = vi.fn();
    render(<AppNumberField value={0} onValueChange={() => {}} onCommit={onCommit} ariaLabel="x" />);
    await userEvent.type(screen.getByLabelText("x"), "12");
    await committed(onCommit, 12);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Blur through the full event chain → Base UI's inputBlur commit fires
    // onValueCommitted(12) again; the dedup guard must suppress the duplicate.
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not emit null onValueChange when the field is cleared", async () => {
    const onValueChange = vi.fn();
    render(<AppNumberField value={3} onValueChange={onValueChange} ariaLabel="x" />);
    await userEvent.clear(screen.getByLabelText("x"));
    expect(onValueChange).not.toHaveBeenCalledWith(null);
  });

  it("disables the input", () => {
    render(<AppNumberField value={1} onValueChange={() => {}} disabled ariaLabel="x" />);
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });

  it("renders an empty field when value is null", () => {
    render(<AppNumberField value={null} onValueChange={() => {}} ariaLabel="x" />);
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("");
  });

  it("calls onClear (not onValueChange) when an optional field is cleared", async () => {
    const onValueChange = vi.fn();
    const onClear = vi.fn();
    render(
      <AppNumberField value={5} onValueChange={onValueChange} onClear={onClear} ariaLabel="x" />,
    );
    await userEvent.clear(screen.getByLabelText("x"));
    expect(onClear).toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalledWith(null);
  });
});
