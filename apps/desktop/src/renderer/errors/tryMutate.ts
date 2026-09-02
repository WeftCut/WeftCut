import i18n from "../i18n";
import { logEmit } from "../ipc";
import { formatCommandError, type FormattedRefusal } from "./formatCommandError";
import { parseCommandError, type CommandError } from "./parseCommandError";

/// Parse + format in one step: the fields a log entry needs when a rejection
/// turns out to be a structured refusal, or `null` when it is some other
/// throw (fs, plumbing) and the caller keeps its generic path.
export interface RefusalDescription extends FormattedRefusal {
  /// The parsed structure, for the entry's `details` disclosure.
  error: CommandError;
}

export function describeRefusal(err: unknown): RefusalDescription | null {
  const parsed = parseCommandError(err);
  if (!parsed) return null;
  return { ...formatCommandError(parsed), error: parsed };
}

/// Electron's `ipcRenderer.invoke` rejects with the main-side message wrapped in
/// its own prose — `Error invoking remote method 'backend:invoke': Error: …`.
/// `parseCommandError` peels that off a structured refusal by parsing from the
/// first `{`; a refusal stated in PROSE has no `{` to anchor on, so the sentence
/// would otherwise arrive behind plumbing. The speech tools' messages are the
/// ones that matter here: they name the Settings panel, the payload cap, the
/// split to make.
///
/// Matched loosely on the channel name and swallowing one redundant `Error:`
/// with it, so an Electron major rewording the middle of that sentence degrades
/// to leaving the prose in rather than eating part of the message. A throw that
/// never crossed IPC is untouched.
const IPC_INVOKE_PROSE = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

/// The plain text of a throw that is not a structured refusal, with Electron's
/// IPC prose taken out.
function plainThrowText(err: unknown): string {
  return String(err).replace(IPC_INVOKE_PROSE, "");
}

/// For components that already own an INLINE error slot (Motif lifecycle
/// cards, effects section, the speech dialogs): the refusal line in the active
/// locale, or the throw's own text when the failure isn't a structured refusal.
/// Inline slots beat the status bar on proximity, so they keep their placement
/// and only the copy upgrades.
export function refusalText(err: unknown): string {
  const refusal = describeRefusal(err);
  if (!refusal) return plainThrowText(err);
  return refusal.i18n_key
    ? i18n.t(refusal.i18n_key, {
        ...(refusal.i18n_args ?? {}),
        defaultValue: refusal.message,
      })
    : refusal.message;
}

/// One failed direct commit → one `Project`/`User` log entry. For call sites
/// that already own a try/catch with revert logic (the drag gesture);
/// everything else goes through `tryMutate` below.
///
/// `opId` is for a caller that already announced the run with a `Started` row
/// (the analysis dialogs): the failure row then closes that op as `Err`. The
/// status bar's running badge clears only on a terminal row under the SAME
/// `op_id` (`logs/store.ts` `runningOps`), so a Started row whose failure is
/// logged standalone spins forever.
export function logMutationFailure(err: unknown, context: string, opId?: string): void {
  const closesOp = opId === undefined ? {} : { op_id: opId, op_state: { state: "Err" as const } };
  const refusal = describeRefusal(err);
  if (refusal) {
    void logEmit({
      level: refusal.level,
      category: { kind: "Project" },
      source: { kind: "User" },
      message: refusal.message,
      ...(refusal.i18n_key
        ? { i18n_key: refusal.i18n_key, i18n_args: refusal.i18n_args ?? null }
        : {}),
      details: { context, error: refusal.error },
      ...closesOp,
    });
    return;
  }
  void logEmit({
    level: "error",
    category: { kind: "Project" },
    source: { kind: "User" },
    // Same peel as the inline slot: a row reading Electron's plumbing sentence
    // buries the one instruction the user can act on.
    message: `${context} failed: ${plainThrowText(err)}`,
    details: { context },
    ...closesOp,
  });
}

/// Run a direct commit — a mutation invoked OUTSIDE the command registry
/// (inspector field commits, drag commits, timeline context-menu items),
/// which `runWithLogging` therefore never sees. On failure the refusal
/// becomes one legible `Project`/`User` status-bar line (before this helper,
/// these sites surfaced nothing: an unhandled rejection in devtools).
///
/// Returns false on failure so call sites keep their own revert logic
/// (bounce the field back, drop the drag ghost) without re-catching.
export async function tryMutate(
  fn: () => Promise<unknown>,
  context: string,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    logMutationFailure(err, context);
    return false;
  }
}
