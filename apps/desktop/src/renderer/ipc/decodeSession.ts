// Opens a native decode session from the page and takes its port, for preview
// and export alike (preload/decodeSessionPorts.ts; docs/export-ipc-transport.md
// § Decode-in).

/// Resolves once both the session's open info (from `open`, one of the
/// preload's `*Decode.open` calls) and its port have arrived. They travel
/// separately and several sessions may open at once, so the port is matched
/// to its session by id, never by arrival order.
export function openDecodeSession<Info>(
  sessionId: string,
  open: () => Promise<Info>,
): Promise<{ info: Info; port: MessagePort }> {
  return new Promise((resolve, reject) => {
    let info: { value: Info } | null = null;
    let port: MessagePort | null = null;
    const settle = () => {
      if (info && port) resolve({ info: info.value, port });
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { weftcutDecodeSessionPort?: unknown } | null;
      if (event.source !== window || data?.weftcutDecodeSessionPort !== sessionId || !event.ports[0]) return;
      window.removeEventListener("message", onMessage);
      port = event.ports[0];
      settle();
    };
    window.addEventListener("message", onMessage);
    open().then(
      (opened) => {
        info = { value: opened };
        settle();
      },
      (error: unknown) => {
        window.removeEventListener("message", onMessage);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
