import { logEmit } from "../ipc";

/// Say, once per gesture, why a clip carried into another timeline Panel will
/// not land there: a layer belongs to the composition it was created in and
/// moving it never changes that (ADR 0053 decision 8, `CrossCompositionMove`).
///
/// The status log and not a toast — this app prevents rather than interrupts,
/// and the status bar is where a prevented gesture explains itself (#18). Not a
/// `logMutationFailure` either: nothing is sent, so there is no `CommandError`
/// to render. `Project` at `Warn` for the same reason a refused direct commit is
/// `Project` — it is about this project's layer, not about the gesture that
/// asked (docs/status-log.md).
export function refuseCrossCompositionMove(
  fromCompositionId: string,
  toCompositionId: string,
): void {
  void logEmit({
    level: "warn",
    category: { kind: "Project" },
    source: { kind: "User" },
    message: "A clip cannot be moved into another composition by dragging",
    i18n_key: "log.cross_composition_move",
    details: {
      context: "layer_drag",
      fromCompositionId,
      toCompositionId,
    },
  });
}
