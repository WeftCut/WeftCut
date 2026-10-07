import { useEffect, useRef, useState } from "react";
import { listen } from "@/bridge/events";
import { convertFileSrc } from "@/bridge/ipc";
import { getMediaThumbnail } from "../ipc";
import { useMediaById, useProjectStore } from "../state/projectStore";
import { MediaPosterCache } from "./mediaPosterCache";

const posters = new MediaPosterCache(getMediaThumbnail);
function reconcilePosters() {
  posters.reconcile(new Map([...useProjectStore.getState().mediaById].map(([id, media]) =>
    [id, `${media.path}:${media.size_bytes}`])));
}
reconcilePosters();
useProjectStore.subscribe(reconcilePosters);
let jobListenerInstalled = false;
async function installJobListenerOnce() {
  if (jobListenerInstalled) return;
  jobListenerInstalled = true;
  try {
    await listen<{ media_id: string; kind: string }>("media:job_complete", (event) => {
      if (event.payload?.kind === "thumbnails") posters.completed(event.payload.media_id);
    });
  } catch { jobListenerInstalled = false; }
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
    void installJobListenerOnce();
    return posters.subscribe(mediaId, listener);
  }, [mediaId, resolvedKind, media?.path, media?.size_bytes]);

  if (mediaId === null) return null;
  if (resolvedKind === "image") {
    return media?.available ? convertFileSrc(media.path) : null;
  }
  if (resolvedKind !== "video") return null;
  return posters.get(mediaId);
}

export function MediaThumbnail({
  mediaId,
  mediaKind,
}: {
  mediaId: string;
  mediaKind: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !root.current) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0));
    }, { rootMargin: "128px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  // MediaPool keeps offscreen cards mounted. Only visible/nearby cards pin a
  // poster and its decoded browser image; otherwise the floor grows forever.
  const src = useMediaPosterSrc(visible ? mediaId : null, mediaKind);
  return <div ref={root} className={`media-thumbnail${src === null ? " is-placeholder" : ""}`}>
    {src !== null && <img src={src} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
  </div>;
}
