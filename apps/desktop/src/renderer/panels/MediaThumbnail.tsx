import { useEffect, useState } from "react";
import { listen } from "@/bridge/events";
import { convertFileSrc } from "@/bridge/ipc";
import { getMediaThumbnail } from "../ipc";
import { useMediaById } from "../state/projectStore";

type CacheEntry =
  | { state: "pending" }
  | { state: "not_ready" }
  | { state: "ready"; dataUrl: string }
  | { state: "error"; message: string };

const thumbCache = new Map<string, CacheEntry>();
const thumbListeners = new Map<string, Set<() => void>>();
let jobListenerInstalled = false;

function fireListeners(mediaId: string) {
  thumbListeners.get(mediaId)?.forEach((cb) => cb());
}

async function ensureThumbnail(mediaId: string) {
  const cached = thumbCache.get(mediaId);
  if (
    cached?.state === "pending" ||
    cached?.state === "ready" ||
    cached?.state === "error"
  ) {
    return;
  }
  thumbCache.set(mediaId, { state: "pending" });
  try {
    const dataUrl = await getMediaThumbnail(mediaId);
    thumbCache.set(mediaId, { state: "ready", dataUrl });
  } catch (e) {
    const message = typeof e === "string" ? e : String(e);
    if (message.includes("not_ready")) {
      thumbCache.set(mediaId, { state: "not_ready" });
    } else {
      thumbCache.set(mediaId, { state: "error", message });
    }
  }
  fireListeners(mediaId);
}

async function installJobListenerOnce() {
  if (jobListenerInstalled) return;
  jobListenerInstalled = true;
  await listen<{ media_id: string; kind: string }>(
    "media:job_complete",
    (event) => {
      if (event.payload?.kind === "thumbnails") {
        // Drop the stale "not_ready" cache entry AND kick off a fresh fetch.
        // Deleting alone wouldn't help — listeners would re-render but the
        // useEffect deps haven't changed, so no automatic refetch.
        thumbCache.delete(event.payload.media_id);
        void ensureThumbnail(event.payload.media_id);
      }
    },
  );
}

/// The `src` a poster image for `mediaId` should use, or null while none exists
/// — a generated data URL for video, the file itself for an image.
///
/// Extracted from the component below because the timeline draws the same poster
/// on a Group clip (`TimelineVisualPreview`) and must not inherit the media
/// pool's `.media-thumbnail` sizing to get it. The module-level cache, the
/// in-flight de-duplication and the `media:job_complete` re-fetch are all shared
/// by having ONE hook: two independent fetch paths would race the same job.
///
/// `mediaId` null asks for nothing and subscribes to nothing, which is what lets
/// a caller hold the hook unconditionally for a layer that has no media.
export function useMediaPosterSrc(
  mediaId: string | null,
  mediaKind: string,
): string | null {
  const [, setTick] = useState(0);
  const media = useMediaById(mediaId);
  const resolvedKind = (media?.kind ?? mediaKind).toLowerCase();

  useEffect(() => {
    // Only videos produce generated thumbnails; image media display the
    // original file directly.
    if (mediaId === null || resolvedKind !== "video") return;
    const listener = () => setTick((t) => t + 1);
    let listeners = thumbListeners.get(mediaId);
    if (!listeners) {
      listeners = new Set();
      thumbListeners.set(mediaId, listeners);
    }
    listeners.add(listener);
    void installJobListenerOnce();
    void ensureThumbnail(mediaId);
    return () => {
      listeners?.delete(listener);
    };
  }, [mediaId, resolvedKind]);

  if (mediaId === null) return null;
  if (resolvedKind === "image") {
    return media?.available ? convertFileSrc(media.path) : null;
  }
  if (resolvedKind !== "video") return null;
  const entry = thumbCache.get(mediaId);
  return entry?.state === "ready" ? entry.dataUrl : null;
}

export function MediaThumbnail({
  mediaId,
  mediaKind,
}: {
  mediaId: string;
  mediaKind: string;
}) {
  const src = useMediaPosterSrc(mediaId, mediaKind);
  if (src === null) return <div className="media-thumbnail is-placeholder" />;
  return <img className="media-thumbnail" src={src} alt="" draggable={false} />;
}
