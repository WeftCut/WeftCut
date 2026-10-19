// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "../i18n";
import { useSettingsRequest } from "../settings/settingsRequest";
import { ComputeRefusal } from "./ComputeRefusal";
import { computeFailureText, computeRefusalSummary, computeResourceReason } from "./computeRefusalMessage";

// The native sentences, verbatim from `native/src/resources.rs` (and the
// `audio extract:` prefix `transcribe_clip` puts on them): the wording is the
// contract these tests pin.
const HEAD = "audio extract: resource-capacity-exceeded: Waited 60 s before extracting clip audio";
const NATIVE = {
  memory: `${HEAD}: memory is under pressure. Close other work or wait for memory to recover, then retry`,
  finalization: `${HEAD}: an export is finishing and goes first. Retry when the export completes`,
  budget: `${HEAD}: the CPU and memory budget is held by 2 other lease(s), 1 of them background processing such as proxy generation. Retry when it finishes, or raise Processing effort or the Memory target in Settings`,
  allowance: "resource-capacity-exceeded: Requested 128 MiB working memory exceeds the 64 MiB allowance; increase the memory target",
  queue: "resource-capacity-exceeded: Too many queued tasks; retry when current work finishes",
  busy: "resource-capacity-exceeded: Resources are busy. Stop playback or wait for other processing, then retry",
} as const;

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useSettingsRequest.setState({ request: null });
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en-US");
});

describe("computeResourceReason", () => {
  it("reads each native refusal's reason", () => {
    for (const [reason, text] of Object.entries(NATIVE)) expect(computeResourceReason(text)).toBe(reason);
  });

  it("is null for a failure that is not a resource refusal", () => {
    expect(computeResourceReason("no transcription model available")).toBeNull();
  });
});

describe("computeRefusalSummary", () => {
  it("summarizes in the UI language, names the task, and leaves the jargon out", () => {
    const summary = computeRefusalSummary(i18n.t, "describe_clip", NATIVE.budget)!;
    expect(summary).toContain("描述");
    expect(summary).toContain("代理文件");
    expect(summary).toContain("设置 → 性能");
    expect(summary).not.toMatch(/resource-capacity-exceeded|lease|Waited/);
  });

  it("keeps any other failure's own sentence", () => {
    expect(computeFailureText(i18n.t, "transcribe_clip", "no transcription model available")).toBe(
      "no transcription model available",
    );
  });
});

describe("ComputeRefusal", () => {
  it("shows the summary, a way to Performance settings, and the native sentence folded away", () => {
    render(<ComputeRefusal text={NATIVE.memory} tool="transcribe_clip" testId="refusal" />);
    expect(screen.getByTestId("refusal").textContent).toContain("转写未能开始");
    expect(screen.getByText("技术详情")).toBeTruthy();
    expect(screen.getByText(NATIVE.memory).closest("details")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开性能设置" }));
    expect(useSettingsRequest.getState().request?.category).toBe("performance");
  });

  it("offers no settings where no setting helps", () => {
    render(<ComputeRefusal text={NATIVE.finalization} tool="describe_clip" />);
    expect(screen.queryByRole("button", { name: "打开性能设置" })).toBeNull();
    expect(screen.getByText(/等待导出完成/)).toBeTruthy();
  });

  it("renders any other failure as its own sentence", () => {
    render(<ComputeRefusal text="no backend available" tool="describe_clip" testId="refusal" />);
    expect(screen.getByTestId("refusal").textContent).toBe("no backend available");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
