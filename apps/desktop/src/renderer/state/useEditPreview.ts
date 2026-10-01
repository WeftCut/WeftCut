import { useEffect, useMemo } from "react";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { previewLocalUs } from "./playheadProjection";
import { usePlaybackStore, type TransportHandle } from "./playbackStore";

/// An editing gesture may show another frame, but cannot relocate the editor's
/// moment. Own pause/preview/restore together so callers cannot accidentally
/// use a navigation seek for a preview, or forget to restore on unmount.
/// `show` takes time on the active preview's clock, just like TransportHandle.
export function useEditPreview() {
  const preview = useMemo(() => {
    let session: { transport: TransportHandle; rootUs: number } | null = null;
    return {
      show(localUs: number) {
        const transport = usePlaybackStore.getState().transport;
        if (!transport) return;
        if (session?.transport !== transport) {
          session = { transport, rootUs: playheadTimeUs() };
          transport.pause();
        }
        transport.seek(localUs, "preview");
      },
      end() {
        const saved = session;
        session = null;
        // A project/preview replacement owns a different clock. Old cleanup
        // must never seek that newly registered transport.
        if (!saved || usePlaybackStore.getState().transport !== saved.transport) return;
        setPlayheadTimeUs(saved.rootUs);
        saved.transport.seek(previewLocalUs(saved.rootUs));
      },
    };
  }, []);
  useEffect(() => () => preview.end(), [preview]);
  return preview;
}
