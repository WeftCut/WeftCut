// The editor's half of the companion page (`main/companion/hub.ts`): it
// attaches to main once its listeners are in place, follows the demand main
// gives it, and runs the page's player controls. With no page open the demand
// is empty and the bridge subscribes to nothing; without a page showing the
// picture it captures and encodes nothing (`mirrorEncoder.ts`).
import { invoke, invokeRaw } from "../bridge/ipc";
import { listen, type UnlistenFn } from "../bridge/events";
import { playheadTimeUs, usePlayheadStore } from "../state/playheadStore";
import { transportPause, transportPlay, usePlaybackStore } from "../state/playbackStore";
import {
  COMPANION_ATTACH,
  COMPANION_CONTROL_EVENT,
  COMPANION_DEMAND_EVENT,
  COMPANION_DETACH,
  COMPANION_MIRROR_CHUNK,
  COMPANION_MIRROR_CONFIG,
  COMPANION_TRANSPORT,
  type CompanionAttachReply,
  type CompanionControlMessage,
  type CompanionDemand,
  type CompanionDemandMessage,
  type CompanionMirrorChunkMessage,
  type CompanionMirrorConfigMessage,
} from "../../shared/companion";
import { startMirror, type Mirror, type MirrorSend } from "./mirrorEncoder";

/** The most often the transport goes to main while playing: a page moves its
 *  own playhead between updates, so this sets how soon it corrects, not how
 *  smoothly it moves. */
export const TRANSPORT_PUSH_MS = 100;

/** `seekTo` takes ROOT time and clamps it, as every UI seek does (App.tsx). */
export function installCompanionBridge(seekTo: (rootUs: number) => void): () => void {
  const token = crypto.randomUUID();
  let disposed = false;
  let unwatch: (() => void) | null = null;
  let mirror: Mirror | null = null;
  // Frames are no edit: they skip the publication barrier `invoke` waits on.
  const send: MirrorSend = {
    config: (config) => {
      void invokeRaw(COMPANION_MIRROR_CONFIG, { token, ...config } satisfies CompanionMirrorConfigMessage).catch(() => {});
    },
    chunk: (chunk) => {
      void invokeRaw(COMPANION_MIRROR_CHUNK, { token, ...chunk } satisfies CompanionMirrorChunkMessage).catch(() => {});
    },
  };

  const apply = (demand: CompanionDemand): void => {
    if (disposed) return;
    if (demand.watch && unwatch === null) unwatch = watchTransport(token);
    else if (!demand.watch && unwatch !== null) {
      unwatch();
      unwatch = null;
    }
    if (demand.picture && mirror === null) mirror = startMirror(send);
    else if (!demand.picture && mirror !== null) {
      mirror.stop();
      mirror = null;
    }
  };

  const listening: Array<Promise<UnlistenFn>> = [
    listen<CompanionDemandMessage>(COMPANION_DEMAND_EVENT, ({ payload }) => {
      if (payload.token === token) apply(payload);
    }),
    listen<CompanionControlMessage>(COMPANION_CONTROL_EVENT, ({ payload }) => {
      if (payload.token !== token || disposed) return;
      if (payload.action === "play") transportPlay();
      else if (payload.action === "pause") transportPause();
      else seekTo(payload.t_us);
    }),
  ];

  // Attach only once both listeners are in place: main tells this token of a
  // change only after the attach, and the reply carries the demand until then.
  void Promise.all(listening)
    .then(() => (disposed ? null : invoke<CompanionAttachReply>(COMPANION_ATTACH, { token })))
    .then((reply) => { if (reply) apply(reply.demand); })
    .catch((error: unknown) => console.warn("[companion] attach failed", error));

  return () => {
    disposed = true;
    unwatch?.();
    unwatch = null;
    mirror?.stop();
    mirror = null;
    for (const u of listening) void u.then((f) => f());
    void invoke(COMPANION_DETACH, { token }).catch(() => {});
  };
}

/** Pushes the transport while a page watches: on every play/pause flip, and on
 *  playhead moves at most once per `TRANSPORT_PUSH_MS` (the last one always
 *  lands). Returns the stop. */
function watchTransport(token: string): () => void {
  let lastSent = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (): void => {
    timer = null;
    lastSent = performance.now();
    void invoke(COMPANION_TRANSPORT, {
      token,
      t_us: playheadTimeUs(),
      playing: usePlaybackStore.getState().playing,
    }).catch(() => {});
  };
  const soon = (): void => {
    if (timer !== null) return;
    const wait = TRANSPORT_PUSH_MS - (performance.now() - lastSent);
    if (wait <= 0) send();
    else timer = setTimeout(send, wait);
  };
  const now = (): void => {
    if (timer !== null) clearTimeout(timer);
    send();
  };
  const unsubPlayhead = usePlayheadStore.subscribe(soon);
  const unsubPlayback = usePlaybackStore.subscribe((s, prev) => {
    if (s.playing !== prev.playing) now();
  });
  now();
  return () => {
    unsubPlayhead();
    unsubPlayback();
    if (timer !== null) clearTimeout(timer);
  };
}
