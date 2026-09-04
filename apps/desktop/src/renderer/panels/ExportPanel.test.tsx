// @vitest-environment jsdom
//
// The complete state's action row. Every label must come from the locale
// files — the Play button once used `t(key, { defaultValue })` with a key that
// existed in neither locale, so zh-CN silently showed English; the locale
// switch below is what makes that regression a failing test rather than a
// screenshot someone has to notice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Pin the OS so the reveal label is deterministic (jsdom classifies as linux).
vi.mock("@/platform", async (importActual) => {
  const actual = await importActual<typeof import("@/platform")>();
  return { ...actual, rendererOS: "mac" };
});

import i18n from "../i18n";
import { ExportPanel, type ExportState } from "./ExportPanel";

const OUTPUT = "C:/Users/me/Videos/final.mp4";
const COMPLETE: ExportState = {
  kind: "complete",
  payload: { outputPath: OUTPUT, durationUs: 6_000_000 },
};

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/// The action row under the progress bar. Scoped because the dialog's ✕ is
/// also labelled "Close" — "关闭" in zh-CN, the same word as Dismiss there.
function actions() {
  const row = document.querySelector(".export-actions");
  if (!row) throw new Error("no .export-actions row rendered");
  return within(row as HTMLElement);
}

describe("ExportPanel complete state", () => {
  it("labels Reveal, Play and Dismiss from the en-US locale", () => {
    render(
      <ExportPanel state={COMPLETE} onClose={vi.fn()} onPlay={vi.fn()} onReveal={vi.fn()} />,
    );

    expect(actions().getByRole("button", { name: "Reveal in Finder" })).toBeTruthy();
    expect(actions().getByRole("button", { name: "Play" })).toBeTruthy();
    expect(actions().getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("labels the same three buttons in zh-CN — no English fallback", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <ExportPanel state={COMPLETE} onClose={vi.fn()} onPlay={vi.fn()} onReveal={vi.fn()} />,
    );

    expect(actions().getByRole("button", { name: "在 Finder 中显示" })).toBeTruthy();
    expect(actions().getByRole("button", { name: "播放" })).toBeTruthy();
    expect(actions().getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(actions().queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("hands the exported path to onReveal and onPlay", async () => {
    const onReveal = vi.fn();
    const onPlay = vi.fn();
    render(<ExportPanel state={COMPLETE} onClose={vi.fn()} onPlay={onPlay} onReveal={onReveal} />);

    await userEvent.click(actions().getByRole("button", { name: "Reveal in Finder" }));
    await userEvent.click(actions().getByRole("button", { name: "Play" }));

    expect(onReveal).toHaveBeenCalledWith(OUTPUT);
    expect(onPlay).toHaveBeenCalledWith(OUTPUT);
  });

  it("offers only Dismiss when no reveal / play handlers are wired", () => {
    render(<ExportPanel state={COMPLETE} onClose={vi.fn()} />);

    expect(actions().getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(actions().queryByRole("button", { name: "Reveal in Finder" })).toBeNull();
    expect(actions().queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("shows no action row at all while the export is still encoding", () => {
    render(
      <ExportPanel
        state={{ kind: "progress", progress: { progress: 0.5, currentTimeUs: 0, frame: 90, fps: 30, speed: 1 } }}
        onClose={vi.fn()}
        onPlay={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    expect(document.querySelector(".export-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });
});
