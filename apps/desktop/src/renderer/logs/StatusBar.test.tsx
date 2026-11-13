// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, within } from "@testing-library/react";
import "../i18n";
import type { LogEntry, LogLevel } from "../ipc";
import type { AppNotice } from "../../shared/ipc";
import type { Change } from "../../shared/review";
import { StatusBar } from "./StatusBar";
import { useLogStore } from "./store";
import { receiveSaveStatus, useSaveStatusStore } from "../state/saveStatusStore";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
// No backend under jsdom: IPC answers nothing (the review fetch keeps its last
// view; a command's log row goes nowhere).
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

afterEach(async () => {
  cleanup();
  useLogStore.setState({ entries: [], unseenErrors: 0, consoleOpen: false, latest: null, latestStickyUntil: 0 });
  useSaveStatusStore.setState({ status: { state: "ok", revision: 0 } });
  const { resetReviewForTests } = await import("../agent/reviewStore");
  resetReviewForTests();
  const { resetDerivativeJobsForTests } = await import("../state/derivativeJobsStore");
  resetDerivativeJobsForTests();
});

let entryId = 0;
const entry = (level: LogLevel, message: string): LogEntry => ({
  id: `e${++entryId}`, ts: "2026-01-02T03:04:05.000Z", level,
  category: { kind: "Project" }, source: { kind: "User" }, message,
});
const log = (e: LogEntry) => act(() => useLogStore.getState().append(e));

function renderBar(props: { logsOpen?: boolean; notices?: AppNotice[]; onToggleLogs?: () => void } = {}) {
  const view = render(
    <StatusBar
      notices={props.notices ?? []}
      onToggleLogs={props.onToggleLogs ?? vi.fn()}
      logsOpen={props.logsOpen ?? false}
      onOpenSettings={vi.fn()}
      saveActions={{ retry: vi.fn(async () => {}), saveAs: vi.fn(), openFolder: vi.fn(async () => {}) }}
    />,
  );
  const bar = view.container.querySelector<HTMLElement>(".status-bar")!;
  const logLine = () => within(bar).getByTestId("status-bar-log");
  const errors = () => bar.querySelector<HTMLElement>('[data-testid="status-bar-errors"]');
  const announced = () => bar.querySelector('[aria-live="polite"]')!.textContent;
  return { ...view, bar, logLine, errors, announced };
}

describe("log line", () => {
  it("is one button that toggles the log, named by its message and what a press does", async () => {
    const onToggleLogs = vi.fn();
    const { logLine, rerender } = renderBar({ onToggleLogs });
    await act(async () => {});
    expect(logLine().tagName).toBe("BUTTON");
    expect(logLine().getAttribute("aria-expanded")).toBe("false");
    expect(logLine().getAttribute("aria-label")).toBe("No activity yet — Open the log");

    log(entry("info", "Clip trimmed"));
    expect(logLine().textContent).toContain("Clip trimmed");
    expect(logLine().getAttribute("aria-label")).toBe("Clip trimmed — Open the log");
    act(() => logLine().click());
    expect(onToggleLogs).toHaveBeenCalledTimes(1);

    rerender(
      <StatusBar notices={[]} onToggleLogs={onToggleLogs} logsOpen onOpenSettings={vi.fn()}
        saveActions={{ retry: vi.fn(async () => {}), saveAs: vi.fn(), openFolder: vi.fn(async () => {}) }} />,
    );
    expect(logLine().getAttribute("aria-expanded")).toBe("true");
    expect(logLine().getAttribute("aria-label")).toBe("Clip trimmed — Close the log");
  });

  it("puts the source before the message, as the console row has it", async () => {
    const { logLine } = renderBar();
    await act(async () => {});
    log({ ...entry("info", "split_layers"), source: { kind: "Agent", client: "Claude" } });
    const source = logLine().querySelector(".status-bar-source")!;
    const message = logLine().querySelector(".status-bar-message")!;
    expect(source.textContent).toBe("Agent · Claude");
    expect(source.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("swaps the level dot for a count of errors the log has not shown, and drops it once the log opens", async () => {
    const { logLine, errors } = renderBar();
    await act(async () => {});
    log(entry("warn", "Proxy slow"));
    expect(errors()).toBeNull();
    expect(logLine().querySelector(".status-bar-level-dot.level-warn")).not.toBeNull();

    log(entry("error", "Export failed"));
    log(entry("error", "Decode failed"));
    expect(errors()!.textContent).toBe("2");
    expect(logLine().querySelector(".status-bar-level-dot")).toBeNull();
    expect(logLine().getAttribute("aria-label")).toBe("2 new errors — Decode failed — Open the log");

    act(() => useLogStore.getState().setConsoleOpen(true));
    expect(errors()).toBeNull();
    expect(logLine().querySelector(".status-bar-level-dot.level-error")).not.toBeNull();
  });

  it("announces each error with the count the line now shows, and not lower levels", async () => {
    const { announced } = renderBar();
    await act(async () => {});
    log(entry("error", "Export failed"));
    expect(announced()).toBe("Error: Export failed. 1 new error");
    log(entry("warn", "Proxy slow"));
    expect(announced()).toBe("Error: Export failed. 1 new error");
    log(entry("error", "Decode failed"));
    expect(announced()).toBe("Error: Decode failed. 2 new errors");

    // With the console open the error is seen there: announced without a count.
    act(() => useLogStore.getState().setConsoleOpen(true));
    log(entry("error", "Mux failed"));
    expect(announced()).toBe("Error: Mux failed");
  });
});

describe("bar contents", () => {
  it("holds the log line and the bell, with no review, System or Logs entry of their own", async () => {
    const { useReview } = await import("../agent/reviewStore");
    const { bar } = renderBar({ notices: [{ level: "warn", code: "keyring_unavailable" }] });
    await act(async () => {});
    const change = (id: `Layer:${string}`): Change => ({ id, class: "added", details: [], composition_id: "r", ranges: [] });
    act(() => {
      useReview.getState().apply({
        version: { session: 1, revision: 1, baseline_revision: 1 }, content_revision: 1, has_baseline: true,
        unreviewed: [change("Layer:a")], user: [], user_count: 0, decorations: [],
      });
    });
    // A notice and unreviewed changes both reach the user through the bell.
    expect(within(bar).getAllByRole("button").map((b) => b.dataset.testid))
      .toEqual(["status-bar-log", "status-bar-bell"]);
    expect(within(bar).getByTestId("status-bar-bell").dataset.level).toBe("warn");
  });

  it("carries the derivative count on the bar at once, ahead of the work pill's show delay", async () => {
    const { derivativeJobStarted } = await import("../state/derivativeJobsStore");
    const { bar } = renderBar();
    await act(async () => {});
    act(() => derivativeJobStarted({ media_id: "fresh", kind: "thumbnails" }));
    expect(bar.getAttribute("data-derivative-jobs")).toBe("1");
    expect(bar.querySelector('[data-testid="status-bar-work"]')).toBeNull();
  });
});

describe("not saved", () => {
  let revision = 0;
  const failing = (code: string | null, last_saved_at: string | null = null) => ({
    state: "failing" as const, revision: ++revision, since: "2026-01-02T03:04:05.000Z", last_saved_at,
    code, path: "/home/u/Demo/project.json", dir: "/home/u/Demo",
  });
  afterEach(() => { revision = 0; });

  it("shows its pill on the right while saving fails, and announces the turn to failing once", async () => {
    const { bar, announced } = renderBar();
    await act(async () => {});
    const pill = () => bar.querySelector<HTMLElement>('[data-testid="not-saved-pill"]');
    expect(pill()).toBeNull();

    act(() => receiveSaveStatus(failing("ENOSPC")));
    expect(pill()!.closest(".status-bar-right")).not.toBeNull();
    expect(announced()).toBe("Project not saved: The disk is full.");

    // A new reason is not a second turn.
    act(() => receiveSaveStatus(failing("EROFS", "2026-01-02T03:00:00.000Z")));
    expect(announced()).toBe("Project not saved: The disk is full.");

    act(() => receiveSaveStatus({ state: "ok", revision: ++revision }));
    expect(pill()).toBeNull();
    act(() => receiveSaveStatus(failing("EACCES")));
    expect(announced()).toBe("Project not saved: WeftCut is not allowed to write to the project folder.");
  });
});
