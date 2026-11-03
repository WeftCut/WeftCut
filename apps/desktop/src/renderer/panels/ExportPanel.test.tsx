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
import { DEFAULT_EXPORT_SETTINGS } from "../../shared/exportSettings";

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

/// The fixed footer. Scoped because the dialog's ✕ is
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

it("keeps a recoverable export modal and offers translated retry and discard actions", async () => {
  await i18n.changeLanguage("zh-CN");
  const onRetry = vi.fn(async () => {}), onDiscard = vi.fn(async () => {}), onClose = vi.fn();
  render(<ExportPanel state={{ kind: "error", detail: "Resources are busy", onRetry, onDiscard }} onClose={onClose} />);
  expect(screen.getByText(/无需重新编码/)).toBeTruthy();
  expect(actions().queryByRole("button", { name: "关闭" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.click(actions().getByRole("button", { name: "重试完成导出" }));
  expect(onRetry).toHaveBeenCalledOnce();
  await userEvent.click(actions().getByRole("button", { name: "放弃导出" }));
  expect(onDiscard).toHaveBeenCalledOnce();
});

it("only renames a retry when the user chooses to edit the filename", async () => {
  const onRetry = vi.fn(async () => {});
  render(<ExportPanel state={{
    kind: "error", detail: "Output already exists", onRetry,
    job: { job_id: "retry", state: "awaiting_retry", filename: "final.mp4", output_path: OUTPUT,
      settings: DEFAULT_EXPORT_SETTINGS, range: { startUs: 0, endUs: 6_000_000 }, agent: false },
  }} onClose={vi.fn()} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("Export settings")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Change filename" }));
  const input = screen.getByRole("textbox", { name: "New filename" });
  await userEvent.clear(input);
  expect(actions().getByRole("button", { name: "Retry finishing export" }).hasAttribute("disabled")).toBe(true);
  await userEvent.type(input, "new-name.mp4");
  await userEvent.click(actions().getByRole("button", { name: "Retry finishing export" }));
  expect(onRetry).toHaveBeenLastCalledWith("new-name.mp4");
  await userEvent.click(screen.getByRole("button", { name: "Keep original filename" }));
  await userEvent.click(actions().getByRole("button", { name: "Retry finishing export" }));
  expect(onRetry).toHaveBeenLastCalledWith(undefined);
});

it("shows the actual published filename and keeps finishing work indeterminate", () => {
  const { rerender } = render(<ExportPanel state={{ kind: "finalizing", step: "audio" }} onClose={vi.fn()} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  expect(screen.getByText("Rendering audio…")).toBeTruthy();
  rerender(<ExportPanel state={{ ...COMPLETE, job: {
    job_id: "done", state: "completed", filename: "request.mp4", output_path: "C:/request.mp4",
    settings: DEFAULT_EXPORT_SETTINGS, range: { startUs: 0, endUs: 6_000_000 }, agent: false,
  } }} onClose={vi.fn()} />);
  expect(screen.getByText("final.mp4")).toBeTruthy();
  expect(screen.queryByText("request.mp4")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("shows cancellation while cleanup drains, with no retry or repeated cancel action", () => {
  const onClose = vi.fn();
  render(<ExportPanel state={{ kind: "error", detail: "Output is busy", onRetry: vi.fn(), onDiscard: vi.fn(),
    job: { job_id: "cancel", state: "awaiting_retry", phase: "cancelling", filename: "final.mp4", output_path: OUTPUT,
      settings: DEFAULT_EXPORT_SETTINGS, range: { startUs: 0, endUs: 6_000_000 }, agent: false },
  }} onClose={onClose} />);
  expect(screen.getByRole("status").textContent).toBe("Cancelling export…");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
});

describe("ExportPanel stalled encoder", () => {
  // The native sink's text when its watchdog stopped the encoder.
  const STALLED = "ffmpeg stdin: ffmpeg-stalled: ffmpeg made no progress for 400 s and was stopped";

  it("says the encoder stopped responding and points at the software encoder", async () => {
    render(<ExportPanel state={{ kind: "error", detail: STALLED }} onClose={vi.fn()} />);
    expect(screen.getByText("The encoder stopped responding, so the export was stopped.")).toBeTruthy();
    expect(screen.getByText(/set Video encoder to Software on the Video tab/)).toBeTruthy();
    expect(screen.queryByText(/Check the technical details/)).toBeNull();
    await userEvent.click(screen.getByText("Technical details"));
    expect(document.querySelector(".export-error-details pre")?.textContent).toBe(STALLED);
  });

  it("says the same in zh-CN", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<ExportPanel state={{ kind: "error", detail: `Finalize failed: ffmpeg wait: ${STALLED.slice(14)}` }} onClose={vi.fn()} />);
    expect(screen.getByText("编码器停止响应，导出已停止。")).toBeTruthy();
    expect(screen.getByText(/“视频”页将“视频编码器”设为“软件”/)).toBeTruthy();
  });

  it("keeps the finalization retry hint when only finishing is retried", () => {
    render(<ExportPanel state={{ kind: "error", detail: `ffmpeg mux: ${STALLED.slice(14)}`, onRetry: vi.fn(async () => {}) }} onClose={vi.fn()} />);
    expect(screen.getByText("The encoder stopped responding, so the export was stopped.")).toBeTruthy();
    expect(screen.getByText(/Retry finishing the export without encoding again/)).toBeTruthy();
    expect(screen.queryByText(/set Video encoder to Software/)).toBeNull();
  });

  it("leaves other failures with the generic hint", () => {
    render(<ExportPanel state={{ kind: "error", detail: "ffmpeg exited 1" }} onClose={vi.fn()} />);
    expect(screen.queryByText(/encoder stopped responding/)).toBeNull();
    expect(screen.getByText(/Check the technical details/)).toBeTruthy();
  });
});
