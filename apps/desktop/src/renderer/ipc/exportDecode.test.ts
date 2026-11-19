import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportDecodeOpenInfo } from "../../shared/frameCarrier/wire";
import { openExportDecode, type ExportDecodeOpenArgs } from "./exportDecode";

/// The page's window as the helper sees it: message listeners, and the
/// preload's `exportDecode.open`, answered by the test.
function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opens = new Map<string, { resolve: (info: ExportDecodeOpenInfo) => void; reject: (e: Error) => void }>();
  const win = {
    addEventListener: (_type: string, l: (event: MessageEvent) => void) => { listeners.add(l); },
    removeEventListener: (_type: string, l: (event: MessageEvent) => void) => { listeners.delete(l); },
    api: {
      exportDecode: {
        open: (args: ExportDecodeOpenArgs) =>
          new Promise<ExportDecodeOpenInfo>((resolve, reject) => { opens.set(args.sessionId, { resolve, reject }); }),
      },
    },
  };
  /// The preload relaying session `sessionId`'s port as a window message.
  const portArrives = (sessionId: string, source: unknown = win) => {
    const port = { sessionId, close: vi.fn() } as unknown as MessagePort;
    for (const l of [...listeners]) l({ source, data: { weftcutExportDecodePort: sessionId }, ports: [port] } as unknown as MessageEvent);
    return port;
  };
  return { win, listeners, opens, portArrives };
}

const info = (width: number): ExportDecodeOpenInfo => ({ width, height: 2, startPtsUs: 0 });
const args = (sessionId: string): ExportDecodeOpenArgs => ({ sessionId, path: "/home/u/a.mov", outFormat: "NV12", window: 6 });

let page: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  page = fakeWindow();
  vi.stubGlobal("window", page.win);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("openExportDecode", () => {
  it("resolves once the open info and the session's own port have both arrived, in either order", async () => {
    const first = openExportDecode(args("a"));
    const portA = page.portArrives("a");
    page.opens.get("a")!.resolve(info(1));
    await expect(first).resolves.toEqual({ info: info(1), port: portA });

    const second = openExportDecode(args("b"));
    page.opens.get("b")!.resolve(info(2));
    const portB = page.portArrives("b");
    await expect(second).resolves.toEqual({ info: info(2), port: portB });
    expect(page.listeners.size, "no listener outlives its session's port").toBe(0);
  });

  it("matches each port to its session by id, not by arrival order", async () => {
    const a = openExportDecode(args("a"));
    const b = openExportDecode(args("b"));
    const portB = page.portArrives("b");
    const portA = page.portArrives("a");
    page.opens.get("a")!.resolve(info(1));
    page.opens.get("b")!.resolve(info(2));
    await expect(a).resolves.toEqual({ info: info(1), port: portA });
    await expect(b).resolves.toEqual({ info: info(2), port: portB });
  });

  it("ignores a port posted by anything but the page's own window", async () => {
    const a = openExportDecode(args("a"));
    page.portArrives("a", {});
    page.opens.get("a")!.resolve(info(1));
    const portA = page.portArrives("a");
    await expect(a).resolves.toEqual({ info: info(1), port: portA });
  });

  it("rejects with the open's failure and stops listening", async () => {
    const a = openExportDecode(args("a"));
    page.opens.get("a")!.reject(new Error("codec failed"));
    await expect(a).rejects.toThrow("codec failed");
    expect(page.listeners.size).toBe(0);
  });
});
