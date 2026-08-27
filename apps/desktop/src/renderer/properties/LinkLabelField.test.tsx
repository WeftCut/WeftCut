// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";
import type { LinkSummary } from "../ipc";
import { LinkLabelField } from "./LinkLabelField";

const ipcMocks = vi.hoisted(() => ({
  linksRename: vi.fn().mockResolvedValue(undefined),
  logEmit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    linksRename: ipcMocks.linksRename,
    logEmit: ipcMocks.logEmit,
  };
});

const link: LinkSummary = { id: "link-1", label: null, layer_ids: ["a", "b"] };

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("LinkLabelField", () => {
  let onMutated: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const renderLine = (l: LinkSummary | null) =>
    render(<LinkLabelField kindLabel="Color" trackLabel="Visual" link={l} onMutated={onMutated} />);
  const openEditor = () => {
    fireEvent.click(screen.getByTestId("link-label-field"));
    return screen.getByRole("textbox");
  };

  beforeEach(() => {
    ipcMocks.linksRename.mockClear();
    onMutated = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("renders the identity line as one text run: member count unlabelled, the label otherwise, or not linked", () => {
    const { rerender } = renderLine(link);
    expect(screen.getByText("Color · Visual · Link of 2 layers")).toBeTruthy();
    rerender(<LinkLabelField kindLabel="Color" trackLabel="Visual" link={{ ...link, label: "Pair" }} onMutated={onMutated} />);
    expect(screen.getByText("Color · Visual · Pair")).toBeTruthy();
    rerender(<LinkLabelField kindLabel="Color" trackLabel="Visual" link={null} onMutated={onMutated} />);
    expect(screen.getByText("Color · Visual · Not linked")).toBeTruthy();
  });

  it("an unlinked line opens no editor", () => {
    renderLine(null);
    fireEvent.click(screen.getByTestId("link-label-field"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Enter commits a new label through links_rename and refreshes", async () => {
    renderLine(link);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "  Pair " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(ipcMocks.linksRename).toHaveBeenCalledWith("link-1", "Pair");
    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("an empty field clears the label rather than reverting", async () => {
    renderLine({ ...link, label: "Pair" });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await flush();
    expect(ipcMocks.linksRename).toHaveBeenCalledWith("link-1", null);
  });

  it("an unchanged commit records nothing", async () => {
    renderLine({ ...link, label: "Pair" });
    fireEvent.blur(openEditor());
    await flush();
    expect(ipcMocks.linksRename).not.toHaveBeenCalled();
    expect(onMutated).not.toHaveBeenCalled();
  });

  it("Escape discards the draft, and the blur that follows does not commit it", async () => {
    renderLine(link);
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await flush();
    expect(ipcMocks.linksRename).not.toHaveBeenCalled();
    expect(screen.getByText("Color · Visual · Link of 2 layers")).toBeTruthy();
  });
});
