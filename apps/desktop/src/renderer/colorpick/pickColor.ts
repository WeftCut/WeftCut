// The global pick-session state machine (singleton — a new call preempts the
// old). Freezes BOTH sample buffers up front: every hover afterwards is a CPU
// read, and live-apply re-renders can never pollute the sample source (the
// chromakey feedback-loop fix). The overlay (PickOverlayHost) renders whenever
// the store holds a session and calls settle() to finish it.
// Spec: docs/features.md#color-picker-eyedropper

import { create } from "zustand";
import { logEmit } from "../ipc";
import { transportPause } from "../state/playbackStore";
import type { EffectInputTarget, PreviewFrame } from './previewSamplerRegistry';
import { getPreviewSampler } from "./previewSamplerRegistry";
import { captureWindowSnapshot, type WindowSnapshot } from "./snapshot";
import { screenPick } from './screenPick';
import type { ScreenPickError } from '../../shared/screenPick';

export interface PickOptions {
  /// Sample the named effect's input, including enabled upstream effects.
  effectInput?: EffectInputTarget;
  /// rAF-throttled by the active overlay; transient, never a project commit.
  onHover?: (hex: string) => void;
}

export interface PickResult {
  hex: string;
  source: "composition" | "effect-input" | "ui" | "screen";
}

export interface PickSession {
  opts: PickOptions;
  /// Frozen composition buffer; null ⇒ canvas-region sampling unavailable.
  comp: PreviewFrame | null;
  /// Frozen window snapshot; null ⇒ non-canvas sampling unavailable.
  snap: WindowSnapshot | null;
  /// Idempotent; clears the store session and resolves the pickColor promise.
  settle(result: PickResult | null): void;
}

interface PickState {
  session: PickSession | null;
  screenPicking: boolean;
  screenError: ScreenPickError | null;
}

export const usePickSessionStore = create<PickState>(() => ({ session: null, screenPicking: false, screenError: null }));
let screenRequest: { session: PickSession; controller: AbortController } | null = null;

export async function startScreenPick(session: PickSession, hint: string): Promise<void> {
  const state = usePickSessionStore.getState();
  if (state.session !== session || state.screenPicking) return;
  const request = { session, controller: new AbortController() };
  screenRequest = request;
  usePickSessionStore.setState({ screenPicking: true, screenError: null });
  // Remove the in-app magnifier and present a clean frame before capture.
  // The original session stays owned throughout this asynchronous handoff.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const reply = await screenPick(request.controller.signal, hint, session.opts.onHover);
  if (screenRequest !== request) return;
  screenRequest = null;
  if (usePickSessionStore.getState().session !== session) return;
  if (reply.kind === 'error') {
    usePickSessionStore.setState({ screenPicking: false, screenError: reply.reason });
  } else {
    session.settle(reply.kind === 'picked' ? { hex: reply.hex, source: 'screen' } : null);
  }
}

function warn(message: string): void {
  void logEmit({
    level: "warn",
    category: { kind: "System" },
    source: { kind: "User" },
    message: `colorpick: ${message}`,
  });
}

/// A call still freezing its buffers (not yet installed in the store).
/// pickColor() must preempt BOTH phases of the previous call — the installed
/// session (store) AND a still-capturing one (this claim) — or the loser's
/// promise leaks unresolved forever.
interface Claim {
  cancelled: boolean;
}
let inFlight: Claim | null = null;

export async function pickColor(opts: PickOptions = {}): Promise<PickResult | null> {
  if (inFlight) inFlight.cancelled = true;
  usePickSessionStore.getState().session?.settle(null);
  transportPause();
  const claim: Claim = { cancelled: false };
  inFlight = claim;

  const sampler = getPreviewSampler();
  const [comp, snap] = await Promise.all([
    sampler
      ? sampler
          .captureFrame(opts.effectInput ? { effectInput: opts.effectInput } : {})
          .catch((e: unknown) => {
            warn(`composition freeze failed: ${String(e)}`);
            return null;
          })
      : Promise.resolve(null),
    captureWindowSnapshot().catch((e: unknown) => {
      warn(`window snapshot failed: ${String(e)}`);
      return null;
    }),
  ]);

  // Preempted while capturing: the newer call owns the store — resolve null
  // WITHOUT installing (installing here would clobber the winner's session).
  if (claim.cancelled) return null;
  if (inFlight === claim) inFlight = null;

  if (!comp && !snap) {
    void logEmit({
      level: "error",
      category: { kind: "System" },
      source: { kind: "User" },
      message: "colorpick: no sample source (preview and window snapshot both failed)",
    });
    return null;
  }

  return new Promise<PickResult | null>((resolve) => {
    let settled = false;
    const session: PickSession = {
      opts,
      comp,
      snap,
      settle(result) {
        if (settled) return;
        settled = true;
        if (screenRequest?.session === session) {
          screenRequest.controller.abort();
          screenRequest = null;
        }
        if (usePickSessionStore.getState().session === session) {
          usePickSessionStore.setState({ session: null, screenPicking: false, screenError: null });
        }
        resolve(result);
      },
    };
    usePickSessionStore.setState({ session, screenPicking: false, screenError: null });
  });
}
