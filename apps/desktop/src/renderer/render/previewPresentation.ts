import { UPDATE_PRIORITY, type Application } from "pixi.js";

import { STAGE, stageAdd, stageNow } from "./perf/stageTimers";

const presentationState = new WeakMap<Application, boolean>();
/// Per-app timed present. `Ticker.remove` matches on function identity, so the
/// listener re-added on every re-show must be the SAME object each time.
const timedPresents = new WeakMap<Application, () => void>();
const timedInstalled = new WeakSet<Application>();

/// The present, bracketed for `STAGE.Present`: `app.render` runs outside every
/// Compositor timer, so the listener slot is the only place it can be measured.
/// LANDMINE: it runs at LOW priority, i.e. AFTER PlaybackEngine's HIGH tick
/// already closed the frame, so the sample lands in the NEXT frame's bucket.
///
/// The render is fenced: Pixi's Ticker re-arms `requestAnimationFrame` only
/// after `update()` returns, so an exception escaping this listener stops the
/// ticker for good — the picture freezes, PlaybackEngine's HIGH tick never runs
/// again (no clock, no audio scheduling) and play/pause cannot revive it. A
/// frame that fails to render costs that frame. Logged on the first failure
/// and every `RENDER_ERROR_LOG_EVERY`th after, so a persistent one stays visible.
const RENDER_ERROR_LOG_EVERY = 300;
function timedPresentFor(app: Application): () => void {
  let present = timedPresents.get(app);
  if (!present) {
    let failures = 0;
    present = (): void => {
      const t = stageNow();
      try {
        app.render();
      } catch (e) {
        if (failures++ % RENDER_ERROR_LOG_EVERY === 0) {
          // eslint-disable-next-line no-console
          console.error(`[weftcut/pixi] preview render threw (${failures}×) — keeping ticker alive:`, e);
        }
      } finally {
        stageAdd(STAGE.Present, t);
      }
    };
    timedPresents.set(app, present);
  }
  return present;
}

/**
 * Swap Pixi's own present listener for the timed one, once per Application.
 *
 * `TickerPlugin` registered `app.render` at LOW priority during `app.init`, and
 * `setPixiPresentationVisible` only re-adds the timed closure after a
 * hide→show cycle. A preview that is never hidden — the normal session — would
 * therefore keep the untimed listener forever, and `STAGE.Present` would read
 * as "never fired" rather than as a cost. Called from the preview's init.
 *
 * LANDMINE: idempotent on purpose. A second `add` of the same closure would
 * register it TWICE and silently render the whole scene twice per tick.
 */
export function installTimedPresent(app: Application): void {
  if (timedInstalled.has(app)) return;
  timedInstalled.add(app);
  app.ticker.remove(app.render, app);
  app.ticker.add(timedPresentFor(app), app, UPDATE_PRIORITY.LOW);
}

/**
 * Gate Pixi's low-priority renderer callback without stopping its ticker.
 * PlaybackEngine stays registered at HIGH priority, so clock and audio
 * ownership continue while a dock tab is hidden.
 */
export function setPixiPresentationVisible(
  app: Application,
  visible: boolean,
): void {
  const previous = presentationState.get(app) ?? true;
  if (previous === visible) return;
  presentationState.set(app, visible);
  if (visible) {
    app.ticker.add(timedPresentFor(app), app, UPDATE_PRIORITY.LOW);
  } else {
    // Normally the timed closure is already installed, so that is what comes
    // off. The `app.render` fallback covers an app that never had
    // `installTimedPresent` called on it (TickerPlugin's own listener).
    app.ticker.remove(timedPresents.get(app) ?? app.render, app);
  }
}
