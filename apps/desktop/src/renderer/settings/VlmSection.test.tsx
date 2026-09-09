// @vitest-environment jsdom
//
// Covers the "Video understanding" Settings section (ADR 0055) — the surface
// that makes `describe_clip` reachable at all. The VLM IPC wrappers are stubbed
// so the three localities can be driven independently; `ManagedContent` is
// stubbed to nothing because the download flow is `contentDownload.test.ts`'s
// subject, not this one's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { VlmBackendInfo, VlmBackendsView } from "../ipc";

const ipc = vi.hoisted(() => ({
  settingsGetVlmBackends: vi.fn(),
  settingsSetVlmPreferred: vi.fn(),
  settingsSetVlmLocal: vi.fn(),
  settingsClearVlmLocal: vi.fn(),
  settingsSetVlmEndpoint: vi.fn(),
  settingsSetVlmDescribe: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});

// The native file picker returns a fixed path so Browse is drivable.
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/bridge/dialog", () => ({ open: dialog.open }));

// Managed downloads have their own tests; here they would only add noise.
vi.mock("./ManagedContent", () => ({ ManagedContent: () => null }));

import i18n from "../i18n";
import { VlmSection } from "./VlmSection";

const onError = vi.fn();

/// `getAllBy*` indexes as `T | undefined` under `noUncheckedIndexedAccess`, and
/// these tests index by ROW ORDER on purpose (two local rows, then the endpoint
/// row). Pinning the element here turns a shifted row count into a named
/// failure instead of a `.disabled of undefined` further down.
function nth<T extends HTMLElement>(els: T[], i: number): T {
  const el = els[i];
  if (!el) throw new Error(`expected at least ${i + 1} matches, got ${els.length}`);
  return el;
}

/// A listing in the shape main returns: every backend, one row per locality.
function view(over: Partial<VlmBackendInfo>[] = []): VlmBackendsView {
  const base: VlmBackendInfo[] = [
    { backend: "qwen3_vl", label: "Qwen3-VL (local)", locality: "local", availability: "needs_binary", selected: false },
    { backend: "minicpm_v", label: "MiniCPM-V (local)", locality: "local", availability: "needs_binary", selected: false },
    { backend: "byo_endpoint", label: "OpenAI-compatible endpoint", locality: "endpoint", availability: "needs_endpoint", selected: false },
  ];
  return {
    preferred_engine: "auto",
    describe_fps: 1,
    describe_focus: "general",
    backends: base.map((b) => {
      const patch = over.find((o) => o.backend === b.backend);
      return patch ? { ...b, ...patch } : b;
    }),
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onError.mockReset();
  dialog.open.mockReset().mockResolvedValue("C:/picked/file.gguf");
  ipc.settingsGetVlmBackends.mockReset().mockResolvedValue(view());
  ipc.settingsSetVlmPreferred.mockReset().mockResolvedValue(undefined);
  ipc.settingsSetVlmLocal.mockReset().mockResolvedValue(undefined);
  ipc.settingsClearVlmLocal.mockReset().mockResolvedValue(undefined);
  ipc.settingsSetVlmEndpoint.mockReset().mockResolvedValue(undefined);
  ipc.settingsSetVlmDescribe.mockReset().mockResolvedValue(undefined);
});

describe("VlmSection", () => {
  it("with nothing configured, every row names its OWN gap and no engine is active", async () => {
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");
    // The whole point of the panel: the gaps are actionable, not a blanket
    // "unavailable".
    expect(screen.getAllByText("Needs binary")).toHaveLength(2);
    expect(screen.getByText("Needs endpoint URL")).toBeTruthy();
    // No key-gated row: the endpoint's key is optional, so no row can ever say
    // "needs API key".
    expect(screen.queryByText("Needs API key")).toBeNull();
    expect(
      screen.getByText(/No engine configured/),
    ).toBeTruthy();
  });

  it("names the engine the resolver would actually use", async () => {
    ipc.settingsGetVlmBackends.mockResolvedValue(
      view([{ backend: "qwen3_vl", availability: "available", selected: true }]),
    );
    render(<VlmSection onError={onError} />);
    expect(
      await screen.findByText("Active engine: Qwen3-VL (local)"),
    ).toBeTruthy();
  });

  it("a local row needs ALL THREE paths before it can save", async () => {
    const user = userEvent.setup();
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");

    const firstSave = () =>
      nth(screen.getAllByRole("button", { name: "Save" }), 0) as HTMLButtonElement;
    expect(firstSave().disabled).toBe(true);

    // Binary + model only — still not saveable: a GGUF without its projector is
    // text-only, and the availability probe would report needs_model for it.
    await user.type(nth(screen.getAllByLabelText("Binary"), 0), "C:/llama-mtmd-cli.exe");
    await user.type(nth(screen.getAllByLabelText("Model"), 0), "C:/q.gguf");
    expect(firstSave().disabled).toBe(true);

    await user.type(nth(screen.getAllByLabelText("Projector"), 0), "C:/mm.gguf");
    const save = firstSave();
    expect(save.disabled).toBe(false);

    await user.click(save);
    await waitFor(() =>
      expect(ipc.settingsSetVlmLocal).toHaveBeenCalledWith({
        backend: "qwen3_vl",
        binary: "C:/llama-mtmd-cli.exe",
        model: "C:/q.gguf",
        mmproj: "C:/mm.gguf",
      }),
    );
    // A save re-fetches so the badge and the active-engine line go live.
    expect(ipc.settingsGetVlmBackends.mock.calls.length).toBeGreaterThan(1);
  });

  it("Browse fills the projector field from the native picker", async () => {
    const user = userEvent.setup();
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");
    // Three Browse buttons per local row, in binary/model/projector order.
    await user.click(nth(screen.getAllByRole("button", { name: "Browse…" }), 2));
    await waitFor(() =>
      expect(
        (nth(screen.getAllByLabelText("Projector"), 0) as HTMLInputElement).value,
      ).toBe("C:/picked/file.gguf"),
    );
  });

  it("stored local paths populate the row, and Clear is offered only then", async () => {
    ipc.settingsGetVlmBackends.mockResolvedValue(
      view([
        {
          backend: "qwen3_vl",
          availability: "available",
          selected: true,
          local: { binary: "C:/b.exe", model: "C:/m.gguf", mmproj: "C:/p.gguf" },
        },
      ]),
    );
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");
    expect((nth(screen.getAllByLabelText("Binary"), 0) as HTMLInputElement).value).toBe("C:/b.exe");
    expect((nth(screen.getAllByLabelText("Projector"), 0) as HTMLInputElement).value).toBe("C:/p.gguf");
    const clears = screen.getAllByRole("button", { name: "Clear" }) as HTMLButtonElement[];
    expect(nth(clears, 0).disabled).toBe(false); // qwen3_vl: stored
    expect(nth(clears, 1).disabled).toBe(true); // minicpm_v: nothing stored
  });

  it("saving the endpoint omits an untouched key so the stored one survives", async () => {
    const user = userEvent.setup();
    ipc.settingsGetVlmBackends.mockResolvedValue(
      view([
        {
          backend: "byo_endpoint",
          availability: "available",
          selected: true,
          endpoint: { url: "http://h/v1/chat/completions", has_api_key: true },
        },
      ]),
    );
    render(<VlmSection onError={onError} />);
    await screen.findByText("OpenAI-compatible endpoint");
    // The key field renders as "already set", never with the material in it.
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.type).toBe("password");

    await user.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    await waitFor(() =>
      expect(ipc.settingsSetVlmEndpoint).toHaveBeenCalledWith({
        url: "http://h/v1/chat/completions",
      }),
    );
  });

  it("clearing the endpoint sends an empty url, not a separate channel", async () => {
    const user = userEvent.setup();
    ipc.settingsGetVlmBackends.mockResolvedValue(
      view([
        {
          backend: "byo_endpoint",
          availability: "available",
          endpoint: { url: "http://h/v1/chat/completions", has_api_key: false },
        },
      ]),
    );
    render(<VlmSection onError={onError} />);
    await screen.findByText("OpenAI-compatible endpoint");
    await user.click(screen.getAllByRole("button", { name: "Clear" }).at(-1)!);
    await waitFor(() =>
      expect(ipc.settingsSetVlmEndpoint).toHaveBeenCalledWith({ url: "" }),
    );
  });

  // Every row is an editor. There is no status-only row explaining that some
  // other section owns this section's config — the endpoint row owns its key,
  // and nothing here reads the Transcription key.
  it("renders one editable row per backend and no borrowed-key status row", async () => {
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");
    // Two local rows + one endpoint row, each with its own Save.
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(3);
    expect(screen.queryByText(/Transcription section/)).toBeNull();
    expect(screen.queryByText(/Cloud VLM/)).toBeNull();
  });

  it("changing the preferred engine persists it and re-fetches", async () => {
    const user = userEvent.setup();
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");
    await user.click(screen.getByRole("combobox", { name: "Video-understanding engine" }));
    await user.click(await screen.findByRole("option", { name: "OpenAI-compatible endpoint" }));
    await waitFor(() =>
      expect(ipc.settingsSetVlmPreferred).toHaveBeenCalledWith("byo_endpoint"),
    );
    expect(ipc.settingsGetVlmBackends.mock.calls.length).toBeGreaterThan(1);
  });

  // The two run params are this section's now: what used to be asked on every
  // press is a setting, so the panel has to SHOW the current one.
  it("renders the stored sampling and focus, and says what changing them does", async () => {
    ipc.settingsGetVlmBackends.mockResolvedValue({
      ...view(),
      describe_fps: 2.5,
      describe_focus: "shot-type",
    });
    render(<VlmSection onError={onError} />);
    const sampling = (await screen.findByLabelText("Sample")) as HTMLInputElement;
    expect(sampling.value).toBe("2.5");
    expect(
      screen.getByRole("combobox", { name: "Focus" }).textContent,
    ).toContain("Shot type and camera");
    // Worded by VIEW and not by the two controls beside it: the engine, the
    // model and the interface language key the same cache, and a sentence
    // naming only these two would leave a language switch looking like data
    // loss rather than a different view of the same footage.
    expect(screen.getByText(/interface language/)).toBeTruthy();
    expect(screen.getByText(/keeps the existing one/)).toBeTruthy();
  });

  it("changing the focus persists it and re-fetches", async () => {
    const user = userEvent.setup();
    render(<VlmSection onError={onError} />);
    await screen.findByText("Qwen3-VL (local)");
    // Keyboard activation, NOT user.click: a click opens the popup only for the
    // FIRST Select touched in a file, and the engine selector above already
    // spends that (`CanvasSection.test.tsx` documents the landmine).
    const trigger = screen.getByRole("combobox", { name: "Focus" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("true"),
    );
    await user.pointer({
      target: screen.getByRole("option", { name: "Shot type and camera" }),
      keys: "[MouseLeft]",
    });
    await waitFor(() =>
      expect(ipc.settingsSetVlmDescribe).toHaveBeenCalledWith({
        focus: "shot-type",
      }),
    );
    // Mutate-then-refresh, like every other control here: the panel never keeps
    // an optimistic value that could disagree with what main stored.
    expect(ipc.settingsGetVlmBackends.mock.calls.length).toBeGreaterThan(1);
  });

  // The clamp lives in main, so the field re-mirrors the store after a commit
  // rather than keeping its own draft — otherwise a typed 60 would sit there
  // looking accepted.
  it("commits the sampling once per edit and shows main's clamp", async () => {
    const user = userEvent.setup();
    render(<VlmSection onError={onError} />);
    const sampling = (await screen.findByLabelText("Sample")) as HTMLInputElement;
    ipc.settingsGetVlmBackends.mockResolvedValue({ ...view(), describe_fps: 30 });
    await user.clear(sampling);
    await user.type(sampling, "60");
    await user.tab();
    await waitFor(() => expect(ipc.settingsSetVlmDescribe).toHaveBeenCalled());
    expect(ipc.settingsSetVlmDescribe.mock.calls).toHaveLength(1);
    await waitFor(() => expect(sampling.value).toBe("30.0"));
  });

  it("a failing fetch reports through onError instead of blanking the pane", async () => {
    ipc.settingsGetVlmBackends.mockRejectedValue(new Error("boom"));
    render(<VlmSection onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("boom")));
  });
});
