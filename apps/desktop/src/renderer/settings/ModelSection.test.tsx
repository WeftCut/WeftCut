// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import { MODEL_DEFINITIONS, type ModelsView } from "../../shared/inference-models";
const ipc = vi.hoisted(() => ({ modelsUnselect: vi.fn(), modelsClearDownloads: vi.fn(), modelsList: vi.fn(), modelsUse: vi.fn(), modelsCancel: vi.fn(), modelsInstallComponents: vi.fn(), modelsRemoveCustom: vi.fn(), settingsGetVlmBackends: vi.fn(), settingsSetVlmDescribe: vi.fn() }));
const events = vi.hoisted(() => ({ refresh: (() => {}) as () => void }));
vi.mock("../ipc", () => ipc);
vi.mock("@/bridge/events", () => ({ listen: vi.fn(async (_event: string, callback: () => void) => { events.refresh = callback; return () => {}; }) }));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn(async () => "/custom/file") }));
vi.mock("../search/searchIndexStore", () => ({ onDescribeViewChanged: vi.fn() }));
import { open as openFileDialog } from "@/bridge/dialog";
import { ModelSection } from "./ModelSection";
import { VlmSection } from "./VlmSection";
import { onDescribeViewChanged } from "../search/searchIndexStore";

function initial(): ModelsView {
  return { active: { speech: null, vlm: null }, operations: [], models: MODEL_DEFINITIONS.map(p => ({
    ...p, active: false, installed: false, supported: true, missingBytes: 123000000, hasKey: false, customized: false,
    ...(p.locality === "local" ? { local: { binary: `/managed/${p.id}/run.exe`, model: `/managed/${p.id}/weights`, ...(p.backend === "funasr" ? { tokens: "/managed/tokens.txt" } : {}), ...(p.family === "vlm" ? { mmproj: "/managed/projector" } : {}) } } : {}),
  })) };
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  ipc.modelsList.mockResolvedValue(initial());
  ipc.modelsUse.mockResolvedValue(undefined); ipc.modelsCancel.mockResolvedValue(undefined);
});
// Base UI's pointer-open path is timing-sensitive in jsdom (see CanvasSection
// tests). Exercise keyboard opening here and real pointer input in Electron.
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", { name: "Current model" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
}
async function choose(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await openPicker(user);
  await user.click(await screen.findByRole("menuitemradio", { name }));
}
describe("model settings", () => {
  function readySpeech() {
    const v = initial();
    v.active.speech = "whisper-base";
    Object.assign(v.models[0]!, { active: true, installed: true, verified: true, downloadedBytes: 100 });
    Object.assign(v.models[1]!, { installed: true, verified: false, missingBytes: 0 });
    ipc.modelsList.mockImplementation(async () => structuredClone(v));
    return v;
  }
  it("starts with a genuine empty state and performs no model preparation", async () => {
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    expect((await screen.findByTestId("current-model-summary")).textContent).toContain("No model selected");
    expect(screen.queryByText("Whisper Base")).toBeNull();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
    await openPicker(user);
    expect(screen.getByRole("menuitemradio", { name: "None" }).getAttribute("aria-checked")).toBe("true");
    expect(ipc.modelsUse).not.toHaveBeenCalled();
  });
  it("switches installed models directly and retains the summary until verification succeeds", async () => {
    const v = readySpeech();
    ipc.modelsUse.mockImplementation(async () => { v.operations = [{ id: "paraformer-zh", family: "speech", phase: "verifying" }]; });
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await choose(user, /Paraformer/);
    expect(ipc.modelsUse).toHaveBeenCalledExactlyOnceWith({ id: "paraformer-zh" });
    expect(screen.getByTestId("current-model-summary").textContent).toContain("Whisper Base");
    expect(screen.queryByRole("dialog")).toBeNull();
    v.operations = []; v.active.speech = "paraformer-zh";
    v.models[0]!.active = false; Object.assign(v.models[1]!, { active: true, verified: true });
    await act(async () => events.refresh());
    await waitFor(() => expect(screen.getByTestId("current-model-summary").textContent).toContain("Paraformer"));
  });
  it("opens explicit download setup without replacing the selected summary", async () => {
    const v = readySpeech(); v.models[1]!.installed = false; v.models[1]!.missingBytes = 123000000;
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await choose(user, /Paraformer/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Download and use" })).toBeTruthy();
    expect(screen.getByTestId("current-model-summary").textContent).toContain("Whisper Base");
    expect(ipc.modelsUse).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download and use" }));
    expect(ipc.modelsUse).toHaveBeenCalledWith(expect.objectContaining({ id: "paraformer-zh" }));
  });
  it("starts a first download from empty path fields rather than predicted ones", async () => {
    const v = readySpeech();
    // What the main process reports before anything is downloaded: no paths yet.
    Object.assign(v.models[1]!, { installed: false, missingBytes: 123000000, local: { binary: "", model: "" } });
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await choose(user, /Paraformer/);
    expect(screen.queryByRole("textbox", { name: "Custom model name" })).toBeNull();
    const download = await screen.findByRole("button", { name: "Download and use" });
    expect((download as HTMLButtonElement).disabled).toBe(false);
    await user.click(download);
    expect(ipc.modelsUse).toHaveBeenCalledExactlyOnceWith({ id: "paraformer-zh", local: { binary: "", model: "" } });
  });
  it("points the setup card at the summary it replaces and leaves out the Edit toggle", async () => {
    const v = readySpeech(); v.models[1]!.installed = false; v.models[1]!.missingBytes = 123000000;
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await screen.findByTestId("current-model-summary");
    expect(document.querySelector(".settings-model-swap")).toBeNull();
    await choose(user, /Paraformer/);
    const candidate = document.querySelector<HTMLElement>(".settings-model-candidate")!;
    const swap = document.querySelector(".settings-model-swap")!;
    expect(swap.nextElementSibling).toBe(candidate);
    expect(swap.getAttribute("aria-hidden")).toBe("true");
    // Edit there would take the card away rather than collapse it; the current
    // model keeps its own toggle, which does collapse in place.
    expect(within(candidate).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(candidate).getByRole("button", { name: "Download and use" })).toBeTruthy();
    expect(within(screen.getByTestId("current-model-summary")).getByRole("button", { name: "Edit" })).toBeTruthy();
  });
  it("abandons a setup from its own card, before the download starts", async () => {
    const v = readySpeech(); v.models[1]!.installed = false; v.models[1]!.missingBytes = 123000000;
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await choose(user, /Paraformer/);
    const candidate = document.querySelector<HTMLElement>(".settings-model-candidate")!;
    await user.click(within(candidate).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.querySelector(".settings-model-candidate")).toBeNull());
    expect(document.querySelector(".settings-model-swap")).toBeNull();
    expect(ipc.modelsUse).not.toHaveBeenCalled();
    expect(screen.getByTestId("current-model-summary").textContent).toContain("Whisper Base");
    expect(ipc.modelsUnselect).not.toHaveBeenCalled();
  });
  it("abandoning a running download cancels it and closes the card", async () => {
    const v = readySpeech(); v.models[1]!.installed = false; v.models[1]!.missingBytes = 123000000;
    ipc.modelsUse.mockImplementation(async () => { v.operations = [{ id: "paraformer-zh", family: "speech", phase: "downloading" }]; });
    ipc.modelsCancel.mockImplementation(async () => { v.operations = []; });
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await choose(user, /Paraformer/);
    await user.click(await screen.findByRole("button", { name: "Download and use" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(ipc.modelsCancel).toHaveBeenCalledWith("paraformer-zh");
    await waitFor(() => expect(document.querySelector(".settings-model-candidate")).toBeNull());
    expect(screen.getByTestId("current-model-summary").textContent).toContain("Whisper Base");
  });
  it("choosing None cancels preparation and persists unselection", async () => {
    const v = readySpeech(); v.operations = [{ id: "paraformer-zh", family: "speech", phase: "verifying" }];
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await choose(user, /^None$/);
    expect(ipc.modelsCancel).toHaveBeenCalledWith("paraformer-zh");
    expect(ipc.modelsUnselect).toHaveBeenCalledWith("speech");
    expect(ipc.modelsUse).not.toHaveBeenCalled();
  });
  it("edits the current model inside its card without a separate page or dialog", async () => {
    readySpeech(); const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    const summary = await screen.findByTestId("current-model-summary");
    await user.click(within(summary).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(summary).getByRole("textbox", { name: "Device" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(ipc.modelsUse).toHaveBeenCalledWith(expect.objectContaining({ id: "whisper-base", saveOnly: true }));
    await openPicker(user);
    expect(screen.queryByRole("menuitem", { name: "Model library…" })).toBeNull();
  });
  it("opens the file picker where the path it is editing already points", async () => {
    readySpeech(); const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    const summary = await screen.findByTestId("current-model-summary");
    await user.click(within(summary).getByRole("button", { name: "Edit" }));
    const browse = async (label: string) => {
      const row = within(summary).getByRole("textbox", { name: label }).closest(".settings-key-input-row");
      await user.click(within(row as HTMLElement).getByRole("button", { name: "Browse…" }));
    };
    await browse("Model");
    expect(openFileDialog).toHaveBeenLastCalledWith({ title: "Model", defaultPath: "/managed/whisper-base/weights" });
    // Nothing configured yet (a managed model before its download lands): the
    // starting directory is the OS's to choose.
    await user.clear(within(summary).getByRole("textbox", { name: "Binary" }));
    await browse("Binary");
    expect(openFileDialog).toHaveBeenLastCalledWith({ title: "Binary" });
  });
  it("offers actual speech adapters and describes the fixed OpenAI service", async () => {
    readySpeech(); const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await openPicker(user); await user.click(screen.getByRole("menuitem", { name: "Add custom model…" }));
    expect(screen.getByTestId("current-model-summary").textContent).toContain("Whisper Base");
    expect(screen.getByRole("button", { name: /sherpa-onnx/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /OpenAI Whisper/ }));
    expect(screen.getByText(/fixed whisper-1/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "URL" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Custom model name" }), "My OpenAI");
    await user.type(screen.getByLabelText("API Key"), "test-key");
    await user.click(screen.getByRole("button", { name: "Add without selecting" }));
    expect(ipc.modelsUse).toHaveBeenCalledWith(expect.objectContaining({ id: "openai-whisper", backend: "openai", createCustom: true, saveOnly: true, apiKey: "test-key" }));
  });
  it("shows projector fields for the MiniCPM adapter and requires all local files", async () => {
    const user = userEvent.setup(); render(<ModelSection family="vlm" onError={vi.fn()} />);
    await openPicker(user); await user.click(screen.getByRole("menuitem", { name: "Add custom model…" }));
    await user.click(screen.getByRole("button", { name: /MiniCPM-V/ }));
    expect(screen.getByText(/matching mmproj/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add and use" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("textbox", { name: "URL" })).toBeNull();
  });
  it("retries a failed Add without selecting with the same save-only intent", async () => {
    const v = readySpeech();
    ipc.modelsUse.mockImplementation(async () => { v.operations = [{ id: "openai-whisper", family: "speech", phase: "error", error: "Rejected" }]; });
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await openPicker(user); await user.click(screen.getByRole("menuitem", { name: "Add custom model…" }));
    await user.click(screen.getByRole("button", { name: /OpenAI Whisper/ }));
    await user.type(screen.getByRole("textbox", { name: "Custom model name" }), "My OpenAI");
    await user.type(screen.getByLabelText("API Key"), "test-key");
    await user.click(screen.getByRole("button", { name: "Add without selecting" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(ipc.modelsUse).toHaveBeenLastCalledWith(expect.objectContaining({ saveOnly: true, createCustom: true, name: "My OpenAI" }));
    expect(screen.getByTestId("current-model-summary").textContent).toContain("Whisper Base");
  });
  it("confirms removal of an active custom entry with a None fallback", async () => {
    const v = readySpeech(); Object.assign(v.models[0]!, { custom: true, name: "My Whisper" });
    const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Remove custom entry" }));
    expect(screen.getByText(/selection will be None/)).toBeTruthy();
    expect(ipc.modelsRemoveCustom).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(ipc.modelsRemoveCustom).toHaveBeenCalledWith("whisper-base");
  });
  it("clears downloads from the current card with a separate explicit confirmation", async () => {
    readySpeech(); const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Clear downloads" }));
    expect(screen.getByText(/Shared files needed/)).toBeTruthy();
    expect(ipc.modelsClearDownloads).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(ipc.modelsClearDownloads).toHaveBeenCalledWith("whisper-base");
  });
  it("keeps video analysis options outside model editors, including when None is selected", async () => {
    ipc.settingsGetVlmBackends.mockResolvedValue({ describe_fps: 1, describe_focus: "general" });
    ipc.settingsSetVlmDescribe.mockResolvedValue(undefined);
    const user = userEvent.setup(); render(<VlmSection onError={vi.fn()} />);
    expect(await screen.findByText("Video analysis options")).toBeTruthy();
    const input = await screen.findByLabelText("Sample", { exact: true });
    await user.clear(input); await user.type(input, "2"); await user.tab();
    await waitFor(() => expect(ipc.settingsSetVlmDescribe).toHaveBeenCalledWith({ fps: 2 }));
    expect(onDescribeViewChanged).toHaveBeenCalled();
    await choose(user, /Online model/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".settings-model-editor")?.textContent).not.toContain("Video analysis options");
  });
  it("does not overwrite an editor draft when background status changes", async () => {
    const v = readySpeech(); const user = userEvent.setup(); render(<ModelSection family="speech" onError={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const input = screen.getByRole("textbox", { name: "Device" });
    await user.type(input, "cpu");
    v.models[0]!.downloadedBytes = 300;
    await act(async () => events.refresh());
    expect((input as HTMLInputElement).value).toBe("cpu");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(ipc.modelsUse).toHaveBeenCalledWith(expect.objectContaining({ saveOnly: true, local: expect.objectContaining({ device: "cpu" }) }));
  });
});
