// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevMenu } from "./AppMenuBar";

describe("DevMenu", () => {
  afterEach(cleanup);

  it("renders no Dev chrome when disabled for a production build", () => {
    const { container } = render(<DevMenu enabled={false} />);

    expect(container.childElementCount).toBe(0);
    expect(screen.queryByText("Performance Monitor")).toBeNull();
  });

  it("opens the Performance Monitor from the development dropdown", async () => {
    const onOpen = vi.fn();
    render(<DevMenu enabled onOpenPerformanceMonitor={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: /Dev/ }));
    const entry = await screen.findByText("Performance Monitor");
    fireEvent.click(entry);

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("runs the Motif cold start from the development dropdown", async () => {
    const onColdStart = vi.fn();
    render(<DevMenu enabled onMotifColdStart={onColdStart} />);

    fireEvent.click(screen.getByRole("button", { name: /Dev/ }));
    fireEvent.click(await screen.findByText(/Motif Cold Start/));

    expect(onColdStart).toHaveBeenCalledOnce();
  });

  it("disables the Motif cold start without a project to restart", async () => {
    render(<DevMenu enabled />);

    fireEvent.click(screen.getByRole("button", { name: /Dev/ }));
    const entry = (await screen.findByText(/Motif Cold Start/)).closest("[role=menuitem]");

    expect(entry?.getAttribute("aria-disabled")).toBe("true");
  });
});
