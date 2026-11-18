// Opens a native export decode session from the page and takes its port
// (main/exportDecode.ts; docs/export-ipc-transport.md § Decode-in).

import type { ExportDecodeOpenInfo } from "../../shared/frameCarrier/wire";
import type { WeftcutApi } from "../../shared/ipc";

export type ExportDecodeOpenArgs = Parameters<WeftcutApi["exportDecode"]["open"]>[0];

/// Resolves once both the session's open info and its port have arrived. They
/// travel separately and several sessions may open at once, so the port is
/// matched to its session by id, never by arrival order.
export function openExportDecode(
  args: ExportDecodeOpenArgs,
): Promise<{ info: ExportDecodeOpenInfo; port: MessagePort }> {
  return new Promise((resolve, reject) => {
    let info: ExportDecodeOpenInfo | null = null;
    let port: MessagePort | null = null;
    const settle = () => {
      if (info && port) resolve({ info, port });
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { weftcutExportDecodePort?: unknown } | null;
      if (event.source !== window || data?.weftcutExportDecodePort !== args.sessionId || !event.ports[0]) return;
      window.removeEventListener("message", onMessage);
      port = event.ports[0];
      settle();
    };
    window.addEventListener("message", onMessage);
    window.api.exportDecode.open(args).then(
      (opened) => {
        info = opened;
        settle();
      },
      (error: unknown) => {
        window.removeEventListener("message", onMessage);
        // Closing a port that did arrive closes its session in main.
        port?.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
