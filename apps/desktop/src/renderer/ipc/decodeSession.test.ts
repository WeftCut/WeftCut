import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDecodeSession } from "./decodeSession";

type Info = { width: number };

/// The page's window as the helper sees it: message listeners, and an open
/// call answered by the test.
function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opens = new Map<string, { resolve: (info: Info) => void; reject: (e: Error) => void }>();
  const win = {
    addEventListener: (_type: string, l: (event: MessageEvent) => void) => { listeners.add(l); },
    removeEventListener: (_type: string, l: (event: MessageEvent) => void) => { listeners.delete(l); },
  };
  const open = (sessionId: string) => () =>
    new Promise<Info>((resolve, reject) => { opens.set(sessionId, { resolve, reject }); });
  /// The preload relaying session `sessionId`'s port as a window message.
  const portArrives = (sessionId: string, source: unknown = win) => {
    const port = { sessionId, close: vi.fn() } as unknown as MessagePort;
    for (const l of [...listeners]) l({ source, data: { weftcutDecodeSessionPort: sessionId }, ports: [port] } as unknown as MessageEvent);
    return port;
  };
  return { win, listeners, opens, open, portArrives };
}

const info = (width: number): Info => ({ width });

let page: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  page = fakeWindow();
  vi.stubGlobal("window", page.win);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("openDecodeSession", () => {
  it("resolves once the open info and the session's own port have both arrived, in either order", async () => {
    const first = openDecodeSession("a", page.open("a"));
    const portA = page.portArrives("a");
    page.opens.get("a")!.resolve(info(1));
    await expect(first).resolves.toEqual({ info: info(1), port: portA });

    const second = openDecodeSession("b", page.open("b"));
    page.opens.get("b")!.resolve(info(2));
    const portB = page.portArrives("b");
    await expect(second).resolves.toEqual({ info: info(2), port: portB });
    expect(page.listeners.size, "no listener outlives its session's port").toBe(0);
  });

  it("matches each port to its session by id, not by arrival order", async () => {
    const a = openDecodeSession("a", page.open("a"));
    const b = openDecodeSession("b", page.open("b"));
    const portB = page.portArrives("b");
    const portA = page.portArrives("a");
    page.opens.get("a")!.resolve(info(1));
    page.opens.get("b")!.resolve(info(2));
    await expect(a).resolves.toEqual({ info: info(1), port: portA });
    await expect(b).resolves.toEqual({ info: info(2), port: portB });
  });

  it("ignores a port posted by anything but the page's own window", async () => {
    const a = openDecodeSession("a", page.open("a"));
    page.portArrives("a", {});
    page.opens.get("a")!.resolve(info(1));
    const portA = page.portArrives("a");
    await expect(a).resolves.toEqual({ info: info(1), port: portA });
  });

  it("rejects with the open's failure and stops listening", async () => {
    const a = openDecodeSession("a", page.open("a"));
    page.opens.get("a")!.reject(new Error("codec failed"));
    await expect(a).rejects.toThrow("codec failed");
    expect(page.listeners.size).toBe(0);
  });
});
