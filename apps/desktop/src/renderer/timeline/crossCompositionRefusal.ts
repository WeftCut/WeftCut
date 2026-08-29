import { logEmit } from "../ipc";

/// Say, once per gesture, why a clip carried into another timeline Panel with
/// `Alt` held will not be COPIED there: a copy mints ids, and `applyPasteLayers`
/// links the clones to each other and never back to their sources, so copying
/// across compositions is a second mutation rather than a parameter of the move
/// this gesture already makes.
///
/// It names the way in as well as the wall, because there is one: the same drag
/// WITHOUT `Alt` carries the clips across and lands them where the ghost draws
/// them. A refusal that only said no would send the user looking for a
/// capability they already have.
///
/// The status log and not a toast — this app prevents rather than interrupts,
/// and the status bar is where a prevented gesture explains itself (#18). Not a
/// `logMutationFailure` either: nothing is sent, so there is no `CommandError`
/// to render. `Project` at `Warn` for the same reason a refused direct commit is
/// `Project` — it is about this project's layer, not about the gesture that
/// asked (docs/status-log.md).
export function refuseCrossCompositionCopy(
  fromCompositionId: string,
  toCompositionId: string,
): void {
  void logEmit({
    level: "warn",
    category: { kind: "Project" },
    source: { kind: "User" },
    message:
      "A clip cannot be copied into another composition — release without Alt to move it there",
    i18n_key: "log.cross_composition_copy",
    details: {
      context: "layer_drag",
      fromCompositionId,
      toCompositionId,
    },
  });
}
