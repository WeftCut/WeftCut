// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import { MODEL_DEFINITIONS, type ModelsView } from "../../shared/inference-models";
const ipc = vi.hoisted(() => ({ modelsList: vi.fn(), modelsUse: vi.fn(), modelsCancel: vi.fn(), modelsInstallComponents: vi.fn(), modelsRemoveCustom: vi.fn(), settingsGetVlmBackends: vi.fn(), settingsSetVlmDescribe: vi.fn() }));
const events = vi.hoisted(() => ({ refresh: (() => {}) as () => void }));
vi.mock("../ipc", () => ipc);
vi.mock("@/bridge/events", () => ({ listen: vi.fn(async (_event: string, callback: () => void) => { events.refresh = callback; return () => {}; }) }));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(async () => "/custom/file") }));
vi.mock("../search/searchIndexStore", () => ({ onDescribeViewChanged: vi.fn() }));
import { ModelSection } from "./ModelSection";
import { VlmSection } from "./VlmSection";
import { onDescribeViewChanged } from "../search/searchIndexStore";

function initial(): ModelsView {
  return { active: { speech: null, vlm: null }, operations: [], models: MODEL_DEFINITIONS.map(p => ({
    ...p, active: false, installed: false, supported: true, missingBytes: 123000000, hasKey: false, customized: false,
    ...(p.locality === "local" ? { local: { binary: `/managed/${p.id}/run.exe`, model: `/managed/${p.id}/weights`, ...(p.family === "vlm" ? { mmproj: "/managed/projector" } : {}) } } : {}),
  })) };
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  ipc.modelsList.mockResolvedValue(initial());
  ipc.modelsUse.mockResolvedValue(undefined); ipc.modelsCancel.mockResolvedValue(undefined);
});
async function choose(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name }));
}
describe("model settings", () => {
  it("keeps video sampling and focus in advanced settings and refreshes descriptions after a change", async () => {
    ipc.settingsGetVlmBackends.mockResolvedValue({ describe_fps: 1, describe_focus: "general" });
    ipc.settingsSetVlmDescribe.mockResolvedValue(undefined);
    const user = userEvent.setup(); render(<VlmSection onError={vi.fn()} />);
    const advanced = await screen.findByRole("button", { name: "Advanced settings" });
    expect(screen.queryByRole("combobox", { name: "Focus" })).toBeNull();
    await user.click(advanced);
    await user.click(await screen.findByRole("combobox", { name: "Focus" }));
    await user.click(await screen.findByRole("option", { name: "Shot type and camera" }));
    await waitFor(() => expect(ipc.settingsSetVlmDescribe).toHaveBeenCalledWith({ focus: "shot-type" }));
    expect(onDescribeViewChanged).toHaveBeenCalled();
    expect(ipc.modelsUse).not.toHaveBeenCalled();
  });
  it("previews Whisper without downloading and exposes only one compact card", async () => {
    render(<ModelSection family="speech" onError={vi.fn()} />);
    await screen.findByRole("button", { name: "Download and use" });
    expect(document.querySelectorAll(".settings-model-card")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "Binary" })).toBeNull();
    expect(ipc.modelsUse).not.toHaveBeenCalled();
    expect(screen.queryByText(/recommend/i)).toBeNull();
  });
  it("previews Qwen for vision and keeps online models in the selector", async () => {
    const user = userEvent.setup();
    render(<ModelSection family="vlm" onError={vi.fn()} />);
    await screen.findByRole("button", { name: "Download and use" });
    expect(screen.getByRole("combobox").textContent).toContain("Qwen3-VL-4B");
    await choose(user, /Online model/);
    expect(screen.getByLabelText("API Key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Configure model" })).toBeTruthy();
    expect(ipc.modelsUse).not.toHaveBeenCalled();
  });
  it("browsing another model does not change the active model", async () => {
    const v = initial(); v.active.speech = "whisper-base"; v.models[0]!.active = true;
    ipc.modelsList.mockResolvedValue(v);
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await screen.findByRole("combobox"); await choose(user, /Paraformer/);
    expect(screen.getByText("In use: Whisper Base")).toBeTruthy();
    expect(ipc.modelsUse).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download and use" }));
    expect(ipc.modelsUse).toHaveBeenCalledWith(expect.objectContaining({ id: "paraformer-zh" }));
  });
  it("collapsing advanced settings preserves the draft without applying it", async () => {
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Advanced settings" }));
    const binary = screen.getByRole("textbox", { name: "Binary" });
    await user.clear(binary); await user.type(binary, "C:/own/runtime.exe");
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.queryByRole("textbox", { name: "Binary" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect((screen.getByRole("textbox", { name: "Binary" }) as HTMLInputElement).value).toBe("C:/own/runtime.exe");
    expect(ipc.modelsUse).not.toHaveBeenCalled();
  });
  it("requires a name for replacement model files and sends a single candidate", async () => {
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Advanced settings" }));
    const model = screen.getByRole("textbox", { name: "Model" });
    await user.clear(model); await user.type(model, "D:/own/large.bin");
    const button = screen.getByRole("button", { name: "Verify and use" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Custom model name" }), "My large model");
    await user.click(button);
    expect(ipc.modelsUse).toHaveBeenCalledWith(expect.objectContaining({ id: "whisper-base", name: "My large model", local: expect.objectContaining({ model: "D:/own/large.bin" }) }));
  });
  it("reflects background preparation without replacing edited fields", async () => {
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Advanced settings" }));
    const input = screen.getByRole("textbox", { name: "Device" });
    await user.type(input, "cpu");
    const v = initial(); v.operations = [{ id: "whisper-base", family: "speech", phase: "downloading", progress: 0.42 }];
    ipc.modelsList.mockResolvedValue(v);
    await act(async () => { events.refresh(); });
    await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42"));
    expect((input as HTMLInputElement).value).toBe("cpu");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ipc.modelsCancel).toHaveBeenCalledWith("whisper-base");
  });
});
