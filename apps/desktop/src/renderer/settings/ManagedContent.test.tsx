// @vitest-environment jsdom
//
// The managed-content row is a PROJECTION of main-process state: disk rows
// from `content:list`, the download queue from `content:queue` + its event.
// These tests pin the truthfulness that projection buys — a remount mid-stream
// shows the transfer, the last item in flight never reads as "all installed",
// Download enqueues the whole missing set, Cancel stops every pending item,
// and a completion re-reads both surfaces.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  ContentArtifact,
  ContentItem,
  ContentItemStatus,
  ContentListRow,
  ContentQueueSnapshot,
} from "../ipc";

const ipc = vi.hoisted(() => ({
  contentList: vi.fn(),
  contentQueue: vi.fn(),
  contentEnqueue: vi.fn(),
  contentCancel: vi.fn(),
  contentRemove: vi.fn(),
  contentOpenFolder: vi.fn(),
}));
vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});

// The bridge event surface: capture every subscriber so a test can push a
// queue snapshot the way main does.
const bridge = vi.hoisted(() => ({
  handlers: [] as Array<(e: { event: string; id: number; payload: unknown }) => void>,
}));
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(
    async (
      _event: string,
      handler: (e: { event: string; id: number; payload: unknown }) => void,
    ) => {
      bridge.handlers.push(handler);
      return () => {
        bridge.handlers = bridge.handlers.filter((h) => h !== handler);
      };
    },
  ),
}));

import i18n from "../i18n";
import { ManagedContent } from "./ManagedContent";

function vlmItem(
  id: string,
  labelKey: string,
  fields: ContentArtifact["fields"],
  bytes: number,
): ContentItem {
  return {
    id,
    kind: "vlm-model",
    version: "v1",
    labelKey,
    license: { name: "MIT", upstreamUrl: "https://example.com" },
    vlm: { backends: ["qwen3_vl"] },
    platforms: {
      "win32-x64": {
        url: `https://example.com/${id}`,
        sha256: "0".repeat(64),
        bytes,
        archive: "none",
        entryPath: id,
        fields,
      },
    },
  };
}

const RUNTIME = vlmItem("llama-mtmd-runtime", "content_llama_mtmd_runtime", { binary: "x.exe" }, 100);
const MODEL = vlmItem("qwen3-vl-4b-model", "content_qwen3vl_model", { model: "m.gguf" }, 1048576 * 100);
const MMPROJ = vlmItem("qwen3-vl-4b-mmproj", "content_qwen3vl_mmproj", { mmproj: "p.gguf" }, 1048576 * 40);
// A speech row that must never leak into the vlm projection.
const WHISPER: ContentItem = {
  ...vlmItem("whisper-cpp-runtime", "content_whisper_runtime", { binary: "w.exe" }, 1),
  kind: "speech-runtime",
  speech: { backend: "whisper_cpp" },
};
delete (WHISPER as { vlm?: unknown }).vlm;

const installed: ContentItemStatus = {
  state: "installed",
  entryPath: "C:/x",
  installDir: "C:/",
};
function rows(over: Partial<Record<string, ContentItemStatus>> = {}): ContentListRow[] {
  return [
    { item: WHISPER, status: over[WHISPER.id] ?? { state: "not_installed" } },
    { item: RUNTIME, status: over[RUNTIME.id] ?? installed },
    { item: MODEL, status: over[MODEL.id] ?? { state: "not_installed" } },
    { item: MMPROJ, status: over[MMPROJ.id] ?? { state: "not_installed" } },
  ];
}
const empty: ContentQueueSnapshot = { entries: [] };

function push(snapshot: ContentQueueSnapshot): void {
  act(() => {
    for (const h of bridge.handlers) h({ event: "content:queue", id: 0, payload: snapshot });
  });
}

const onChanged = vi.fn(async () => {});
const onError = vi.fn();

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  bridge.handlers = [];
  onChanged.mockClear();
  onError.mockReset();
  ipc.contentList.mockReset().mockResolvedValue(rows());
  ipc.contentQueue.mockReset().mockResolvedValue(empty);
  ipc.contentEnqueue.mockReset().mockResolvedValue(empty);
  ipc.contentCancel.mockReset().mockResolvedValue(undefined);
  ipc.contentRemove.mockReset().mockResolvedValue(undefined);
  ipc.contentOpenFolder.mockReset().mockResolvedValue(undefined);
});

function mount() {
  return render(
    <ManagedContent family="vlm" backend="qwen3_vl" onChanged={onChanged} onError={onError} />,
  );
}

describe("ManagedContent — idle", () => {
  it("with items missing, offers one Download for the set (and only this backend's items count)", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "Download engine & model" })).toBeTruthy();
    expect(screen.queryByText(/Failed/)).toBeNull();
  });

  it("with everything installed, collapses to the managed caption", async () => {
    ipc.contentList.mockResolvedValue(rows({ [MODEL.id]: installed, [MMPROJ.id]: installed }));
    mount();
    expect(await screen.findByRole("button", { name: "Open folder" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download engine & model" })).toBeNull();
  });
});

describe("ManagedContent — a remount mid-download projects the queue", () => {
  it("shows the in-flight item's state and bytes with a Cancel, never a Download button", async () => {
    ipc.contentList.mockResolvedValue(rows({
      [MODEL.id]: { state: "downloading", receivedBytes: 1048576 * 50, totalBytes: 1048576 * 100 },
      [MMPROJ.id]: { state: "queued" },
    }));
    ipc.contentQueue.mockResolvedValue({
      entries: [
        { itemId: MODEL.id, state: "downloading", receivedBytes: 1048576 * 50, totalBytes: 1048576 * 100 },
        { itemId: MMPROJ.id, state: "queued", receivedBytes: 0, totalBytes: 1048576 * 40 },
      ],
    });
    mount();
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByText(/Qwen3-VL 4B model \(Q4_K_M\) — Downloading… · 50\.0 \/ 100\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/Qwen3-VL vision projector \(F16\) — Queued · 40\.0 MB/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.queryByRole("button", { name: "Download engine & model" })).toBeNull();
  });

  it("the LAST item in flight does not read as all installed (no Open folder / Remove)", async () => {
    ipc.contentList.mockResolvedValue(rows({
      [MODEL.id]: installed,
      [MMPROJ.id]: { state: "downloading", receivedBytes: 1, totalBytes: 1048576 * 40 },
    }));
    ipc.contentQueue.mockResolvedValue({
      entries: [{ itemId: MMPROJ.id, state: "downloading", receivedBytes: 1, totalBytes: 1048576 * 40 }],
    });
    mount();
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove download" })).toBeNull();
  });
});

describe("ManagedContent — actions", () => {
  it("Download enqueues every missing id and renders the snapshot main returns", async () => {
    ipc.contentEnqueue.mockResolvedValue({
      entries: [
        { itemId: MODEL.id, state: "downloading", receivedBytes: 0, totalBytes: 1048576 * 100 },
        { itemId: MMPROJ.id, state: "queued", receivedBytes: 0, totalBytes: 1048576 * 40 },
      ],
    });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Download engine & model" }));
    expect(ipc.contentEnqueue).toHaveBeenCalledWith([MODEL.id, MMPROJ.id]);
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByText(/Queued/)).toBeTruthy();
  });

  it("Cancel stops every pending item of this backend", async () => {
    ipc.contentQueue.mockResolvedValue({
      entries: [
        { itemId: MODEL.id, state: "downloading", receivedBytes: 0, totalBytes: 10 },
        { itemId: MMPROJ.id, state: "queued", receivedBytes: 0, totalBytes: 10 },
        // Another backend's item: not ours to cancel.
        { itemId: WHISPER.id, state: "queued", receivedBytes: 0, totalBytes: 10 },
      ],
    });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(ipc.contentCancel).toHaveBeenCalledTimes(2));
    expect(ipc.contentCancel).toHaveBeenCalledWith(MODEL.id);
    expect(ipc.contentCancel).toHaveBeenCalledWith(MMPROJ.id);
  });

  it("a completion pushed from main re-reads the rows and notifies the parent", async () => {
    mount();
    await screen.findByRole("button", { name: "Download engine & model" });
    const listCalls = ipc.contentList.mock.calls.length;

    push({ entries: [{ itemId: MODEL.id, state: "downloading", receivedBytes: 1, totalBytes: 10 }] });
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();

    ipc.contentList.mockResolvedValue(rows({ [MODEL.id]: installed }));
    push({ entries: [] });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ipc.contentList.mock.calls.length).toBe(listCalls + 1);
    // Still one item missing → Download again, from the refreshed rows.
    expect(await screen.findByRole("button", { name: "Download engine & model" })).toBeTruthy();
  });

  it("an error entry turns the button into Retry and names the item and cause", async () => {
    ipc.contentQueue.mockResolvedValue({
      entries: [{ itemId: MODEL.id, state: "error", receivedBytes: 0, totalBytes: 10, error: "HTTP 503 for x" }],
    });
    mount();
    expect(await screen.findByRole("button", { name: "Retry download" })).toBeTruthy();
    expect(screen.getByText(/Qwen3-VL 4B model \(Q4_K_M\): HTTP 503 for x/)).toBeTruthy();
  });

  it("unsubscribes from the queue event on unmount", async () => {
    const view = mount();
    await screen.findByRole("button", { name: "Download engine & model" });
    await waitFor(() => expect(bridge.handlers.length).toBe(1));
    view.unmount();
    expect(bridge.handlers.length).toBe(0);
  });
});
