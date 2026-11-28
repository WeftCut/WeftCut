// The editor's half of the companion page and the side-panel view
// (`main/companion/hub.ts`): it attaches to main once its listeners are in
// place, follows the demand main gives it, runs their player controls, and
// answers a view's picture connection (`picturePeers.ts`). With nothing open
// the demand is empty and the bridge subscribes to nothing; without one
// showing the picture it captures and encodes nothing (`mirrorEncoder.ts`).
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
  COMPANION_MIRROR_FAILED,
  COMPANION_PEERS,
  COMPANION_SIGNAL_ANSWER,
  COMPANION_SIGNAL_EVENT,
  COMPANION_TRANSPORT,
  type CompanionAttachReply,
  type CompanionControlMessage,
  type CompanionDemand,
  type CompanionDemandMessage,
  type CompanionMirrorChunkMessage,
  type CompanionMirrorConfigMessage,
  type CompanionPeersMessage,
  type CompanionSignalAnswerMessage,
  type CompanionSignalMessage,
} from "../../shared/companion";
import { startMirror, type Mirror, type MirrorSend } from "./mirrorEncoder";
import { PicturePeers } from "./picturePeers";

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
  // The views' channels count toward the picture's demand in main, and a
  // channel that opens wants a keyframe to start from. Nothing here is an
  // edit: these, the frames and the answers skip the publication barrier
  // `invoke` waits on.
  const peers = new PicturePeers(
    (open) => { void invokeRaw(COMPANION_PEERS, { token, open } satisfies CompanionPeersMessage).catch(() => {}); },
    () => { mirror?.requestKey(); },
  );
  // Main sends its pages the encoder's frames; the bridge sends its channels
  // the same ones.
  const send: MirrorSend = {
    config: (config) => {
      void invokeRaw(COMPANION_MIRROR_CONFIG, { token, ...config } satisfies CompanionMirrorConfigMessage).catch(() => {});
      peers.stream.configure(config);
    },
    chunk: (chunk) => {
      void invokeRaw(COMPANION_MIRROR_CHUNK, { token, ...chunk } satisfies CompanionMirrorChunkMessage).catch(() => {});
      peers.stream.chunk(chunk.key, chunk.timestamp_us, new Uint8Array(chunk.data));
    },
    // Only the running mirror fails (a stopped one never does). Main then
    // drops the demand and tells the pages; a page asking again starts anew.
    failed: () => {
      mirror = null;
      peers.stream.reset();
      peers.stream.fail();
      void invokeRaw(COMPANION_MIRROR_FAILED, { token }).catch(() => {});
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
      // The next encoder starts with a config of its own, as main's pages do.
      peers.stream.reset();
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
    listen<CompanionSignalMessage>(COMPANION_SIGNAL_EVENT, ({ payload }) => {
      if (payload.token !== token || disposed) return;
      const reply = (answer: { answer: string } | { error: string }): void => {
        void invokeRaw(COMPANION_SIGNAL_ANSWER, { token, request_id: payload.request_id, ...answer } satisfies CompanionSignalAnswerMessage).catch(() => {});
      };
      peers.answer(payload.offer).then(
        (answer) => { reply({ answer }); },
        (error: unknown) => {
          console.warn("[companion] no answer to a view's offer:", error);
          reply({ error: String(error) });
        },
      );
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
    peers.closeAll();
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
