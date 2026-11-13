// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import i18n from "../i18n";
import type { ExportJob } from "../../shared/exportJob";
import type { ExportProgress, ExportState } from "./ExportPanel";
import { ExportProgressPill } from "./ExportProgressPill";

const JOB = { job_id: "j1", filename: "final.mp4", output_path: "/home/u/Videos/final.mp4" } as ExportJob;
const encoding = (progress: number, onCancel?: () => void): ExportState => ({
  kind: "progress",
  background: true,
  job: JOB,
  progress: { progress, currentTimeUs: 0, frame: 90, fps: 30, speed: 1 } satisfies ExportProgress,
  ...(onCancel ? { onCancel } : {}),
});

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
});

it("shows the percent in a ring without a dialog, leaving the editor usable", async () => {
  const onPlay = vi.fn();
  render(
    <>
      <button onClick={onPlay}>Play timeline</button>
      <ExportProgressPill state={encoding(0.5)} />
    </>,
  );

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("progressbar", { name: "Encoding" }).getAttribute("aria-valuenow")).toBe("50");
  expect(screen.getByRole("button", { name: /Export 50%/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Play timeline" }));
  expect(onPlay).toHaveBeenCalledOnce();
});

it("spins without a value before frames encode", () => {
  render(<ExportProgressPill state={{ kind: "starting", background: true }} />);
  const ring = screen.getByRole("progressbar", { name: "Starting export…" });
  expect(ring.hasAttribute("aria-valuenow")).toBe(false);
});

it("opens the details on click, and cancel is only reachable from them", async () => {
  const onCancel = vi.fn();
  render(<ExportProgressPill state={encoding(0.5, onCancel)} />);
  expect(screen.queryByRole("button", { name: "Cancel export" })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: /Export 50%/ }));
  const details = screen.getByRole("region", { name: "Export" });
  expect(details.textContent).toContain("final.mp4");
  expect(details.textContent).toContain("30 fps · 1.0×");
  await userEvent.click(screen.getByRole("button", { name: "Cancel export" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it("closes the details on Escape, returning focus, and on a click outside", async () => {
  render(
    <>
      <button>Elsewhere</button>
      <ExportProgressPill state={encoding(0.5, vi.fn())} />
    </>,
  );
  const trigger = screen.getByRole("button", { name: /Export 50%/ });

  await userEvent.click(trigger);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Export" })).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
  expect(screen.queryByRole("region", { name: "Export" })).toBeNull();
});

it("offers no cancel once the export is cancelling", async () => {
  const state: ExportState = { ...encoding(0.5, vi.fn()), job: { ...JOB, phase: "cancelling" } };
  render(<ExportProgressPill state={state} />);
  await userEvent.click(screen.getByRole("button", { name: /Export/ }));
  expect(screen.getByRole("region", { name: "Export" }).textContent).toContain("Cancelling export…");
  expect(screen.queryByRole("button", { name: "Cancel export" })).toBeNull();
});
