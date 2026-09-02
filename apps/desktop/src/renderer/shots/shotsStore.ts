// The Shots Panel's own state: which clip is being reviewed, the floor report
// behind it, the reduce that becomes rows, and the reviewer's two decisions.
//
// Deliberately separate from `projectStore`, for `historyStore`'s reason: a
// floor report is a whole-source candidate list, and folding it into the summary
// would strap it onto the refetch that runs on every edit whether the Panel is
// open or not. Here the Panel owns the reads, so a closed Panel issues none.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: selecting a clip probes and never
// scans. `shotFloorReportCached` stats a sidecar; `analyzeShotsFloor` decodes a
// whole source and can run for minutes. Clicking clips is the highest-frequency
// gesture in the app, so the scan is reachable only from `analyzeShotSubject`,
// which one deliberate press calls.
//
// The two tuned parameters live on `ProjectSettings.shot_review` — per project,
// because a shoot has one character — and are written through the UNRECORDED
// `update_project_settings`, so tuning never enters the undo stack
// (`docs/preview.md` §Proxies is the same convention).

import { create } from "zustand";

import { describeRefusal, refusalText } from "../errors/tryMutate";
import {
  analyzeShotsFloor,
  getProjectSettings,
  logEmit,
  reduceShotReport,
  shotDefaultOpts,
  shotFloorReportCached,
  shotFloorSensitivity,
  updateProjectSettings,
  type ShotReport,
  type ShotReviewSettings,
} from "../ipc";
import { LatestRequestCoordinator } from "../state/latestRequest";
import { useProjectStore } from "../state/projectStore";

/// The clip under review. A layer and not a media item: the report is
/// source-scoped, but every apply step is layer-scoped, and `[srcInUs, srcOutUs)`
/// is the window the reduce clips to — so a second clip on the same source is a
/// different subject with the same report.
export interface ShotSubject {
  layerId: string;
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
}

export interface ShotsStoreState {
  subject: ShotSubject | null;
  /// Floor reports already fetched, by media id. Re-selecting a clip then costs
  /// one probe and no fetch. Dropped wholesale by `resetShotsStore` when the
  /// Panel closes rather than kept for the session: the map is keyed by media
  /// id, and a relink points that id at different footage.
  reports: ReadonlyMap<string, ShotReport>;
  /// Whether the subject's source has a floor scan on disk. `null` while the
  /// probe is in flight — the one thing that distinguishes "not analyzed" from
  /// "not asked yet", which are two different sentences.
  cached: boolean | null;
  /// The reduce of the subject's report at the current parameters. The rows are
  /// a projection of exactly this, so the Panel computes no span of its own.
  reduced: ShotReport | null;
  /// The media id whose floor scan is running, or null. A second Analyze while
  /// one runs is a no-op — the scan is idempotent, but two would bill two
  /// decodes and race their reports onto one subject.
  analyzing: string | null;
  /// The Analyze failure's own sentence, for the Panel's inline slot. Cleared
  /// when the next attempt starts and when the subject changes.
  error: string;
  /// The detection defaults as RUST states them, kept beside the effective pair
  /// so a project that carries no review parameters — or one that clears them —
  /// falls back without a second read. `null` until `shot_default_opts` lands.
  rustDefaults: { sensitivity: number; minShotUs: number } | null;
  /// The parameters the reduce actually runs at: the project's if it carries
  /// them, else `rustDefaults`. `null` until one of those two reads lands — the
  /// Panel holds no threshold literal of its own, so there is nothing to reduce
  /// at before then.
  sensitivity: number | null;
  minShotUs: number | null;
  /// The floor the scan itself ran at (`shot_floor_sensitivity`) — the lowest a
  /// threshold control may offer, because a value below it cannot invent
  /// candidates the scan never emitted. Held beside `sensitivity` so the bound
  /// and the value it bounds are read from one place.
  floor: number | null;
  /// Opening candidates the reviewer vetoed, by source µs, per media id.
  /// Clearing a candidate merges its shot into the predecessor.
  vetoed: ReadonlyMap<string, ReadonlySet<number>>;
  /// Rows marked for discard, keyed by their span's source start, per media id.
  /// A key whose boundary a threshold change removes goes inert rather than
  /// discarding some other span.
  discarded: ReadonlyMap<string, ReadonlySet<number>>;
}

const INITIAL: ShotsStoreState = {
  subject: null,
  reports: new Map(),
  cached: null,
  reduced: null,
  analyzing: null,
  error: "",
  rustDefaults: null,
  sensitivity: null,
  minShotUs: null,
  floor: null,
  vetoed: new Map(),
  discarded: new Map(),
};

export const useShotsStore = create<ShotsStoreState>(() => ({ ...INITIAL }));

const set = (patch: Partial<ShotsStoreState>): void =>
  useShotsStore.setState(patch);
const get = (): ShotsStoreState => useShotsStore.getState();

/// One coordinator for the probe-then-fetch pair and one for the reduce, so a
/// late answer cannot publish against a subject that has since changed.
///
/// The generation guard is not enough on its own here: `invalidateShotSource`
/// re-runs the pair for a media id the user may already have navigated away
/// from, and a re-run that is the NEWEST request would publish anyway. So every
/// publish also checks that the subject it was issued for is still the subject —
/// which is what "keyed by media id" means in this store.
const sourceRequests = new LatestRequestCoordinator();
const reduceRequests = new LatestRequestCoordinator();

function isSubject(subject: ShotSubject): boolean {
  const current = get().subject;
  return (
    current !== null &&
    current.layerId === subject.layerId &&
    current.mediaId === subject.mediaId &&
    current.srcInUs === subject.srcInUs &&
    current.srcOutUs === subject.srcOutUs
  );
}

function withKey<T>(
  map: ReadonlyMap<string, ReadonlySet<T>>,
  key: string,
  value: T,
  present: boolean,
): ReadonlyMap<string, ReadonlySet<T>> {
  const next = new Map(map);
  const set_ = new Set(map.get(key) ?? []);
  if (present) set_.add(value);
  else set_.delete(value);
  next.set(key, set_);
  return next;
}

const NO_TIMES: ReadonlySet<number> = new Set<number>();

/// The reduce, re-run from whatever the store currently holds. Every input it
/// reads — report, window, threshold, spacing — is store state, so this is the
/// single place a change to any of them relays the rows. A threshold control is
/// therefore a control over `sensitivity` and nothing more.
async function runReduce(): Promise<void> {
  const { subject, sensitivity, minShotUs, reports } = get();
  if (subject === null || sensitivity === null || minShotUs === null) return;
  const report = reports.get(subject.mediaId);
  if (report === undefined) {
    set({ reduced: null });
    return;
  }
  try {
    await reduceRequests.run(
      () =>
        reduceShotReport(report, {
          sensitivity,
          minShotUs,
          inUs: subject.srcInUs,
          outUs: subject.srcOutUs,
        }),
      (reduced) => {
        if (isSubject(subject)) set({ reduced });
      },
    );
  } catch (err) {
    // The reduce is pure Rust over a report already in hand and cannot refuse;
    // only the IPC transport can fail. The last rows stay on screen — stale
    // spans are recoverable, a thrown renderer is not.
    console.warn("[shotsStore] reduce failed; keeping the last rows", err);
  }
}

/// Read the detection defaults and the scan floor once. Both are constants of
/// the build, so a second call is a no-op — the Panel calls it on every mount.
export async function loadShotDefaults(): Promise<void> {
  if (get().rustDefaults !== null) return;
  const [defaults, floor] = await Promise.all([
    shotDefaultOpts(),
    shotFloorSensitivity(),
  ]);
  const rustDefaults = {
    sensitivity: defaults.sensitivity,
    minShotUs: defaults.min_shot_us,
  };
  // This read and `hydrateShotReview` race, and the project's own values win.
  // Seeding only when nothing has set the pair yet is what makes the order
  // between them irrelevant.
  const seed =
    get().sensitivity === null
      ? { sensitivity: rustDefaults.sensitivity, minShotUs: rustDefaults.minShotUs }
      : {};
  set({ rustDefaults, floor, ...seed });
  await runReduce();
}

/// Nothing below the floor: the scan emitted no candidate there, so a threshold
/// under it can only ask for a set that does not exist. The clamp lives here
/// rather than in the control because `floor` does — one home for the bound and
/// the value it bounds.
function clampThreshold(value: number): number {
  const { floor } = get();
  return Math.min(1, Math.max(floor ?? 0, value));
}

/// Write the reviewed parameters onto the project. Unrecorded, like the proxy
/// preferences: tuning a threshold is a preference, and a drag that logged undo
/// entries would bury the edit before it under its own dust.
async function persistShotReview(): Promise<void> {
  const { sensitivity, minShotUs } = get();
  if (sensitivity === null || minShotUs === null) return;
  try {
    await updateProjectSettings({
      shot_review: { sensitivity, min_shot_us: minShotUs },
    });
  } catch (err) {
    // A preference that cannot be written leaves the review fully usable at the
    // values on screen; they are simply not remembered for the next session.
    console.warn("[shotsStore] could not persist the review parameters", err);
  }
}

/// Move the threshold and relay the rows. NO write: a drag is one gesture, and
/// one pointer move is not the end of it — `commitShotThreshold` is.
export function setShotThreshold(value: number): void {
  const next = clampThreshold(value);
  if (get().sensitivity === next) return;
  set({ sensitivity: next });
  void runReduce();
}

/// The end of a threshold gesture, and its one write.
export async function commitShotThreshold(): Promise<void> {
  await persistShotReview();
}

/// A committed minimum-shot-length edit: relay the rows and remember it. One
/// write per edit — `AppNumberField` commits on blur / Enter / step, not per
/// keystroke. Out-of-range values are ignored rather than sent, because the
/// reduce refuses anything but a positive whole number of microseconds.
export async function setShotMinShotUs(us: number): Promise<void> {
  if (!Number.isSafeInteger(us) || us <= 0) return;
  if (get().minShotUs === us) return;
  set({ minShotUs: us });
  void runReduce();
  await persistShotReview();
}

/// Take the review parameters from the open project, falling back to Rust's
/// defaults when it carries none. The project wins on purpose: the values a
/// person tuned against this footage are the ones to come back to.
async function hydrateShotReview(): Promise<void> {
  let review: ShotReviewSettings | null;
  try {
    review = (await getProjectSettings()).shot_review;
  } catch {
    // No project open — whatever the defaults read seeded stands.
    return;
  }
  const { rustDefaults } = get();
  const params =
    review !== null
      ? { sensitivity: review.sensitivity, minShotUs: review.min_shot_us }
      : rustDefaults;
  // `null` on both sides means the defaults read has not landed yet; it will
  // seed the pair itself when it does.
  if (params === null) return;
  set({
    sensitivity: clampThreshold(params.sensitivity),
    minShotUs: params.minShotUs,
  });
  await runReduce();
}

/// Hydrate now, and again whenever the open PROJECT changes — the Panel can
/// stay open across a project swap, and the previous shoot's threshold must not
/// silently apply to the next one.
///
/// Project IDENTITY and not the summary object: `projectStore.apply` installs a
/// brand-new summary on every commit, so comparing objects would re-read the
/// settings on every edit — a round trip per keystroke, and a real race where an
/// unrelated edit's in-flight read resolves after a drag's write and restores
/// the stale value (`proxyPreferenceStore` carries the same note).
export function wireShotReviewPrefs(): () => void {
  void hydrateShotReview();
  return useProjectStore.subscribe((s, prev) => {
    if (s.summary?.project_id !== prev.summary?.project_id) void hydrateShotReview();
  });
}

/// Probe the subject's source and, ONLY on a hit, fetch the report it already
/// has. Both answers publish through one coordinator run, so a switch between
/// the two never publishes half of a stale pair.
async function loadSubjectReport(subject: ShotSubject): Promise<void> {
  try {
    await sourceRequests.run(
      async (): Promise<ShotReport | null> => {
        if (!(await shotFloorReportCached(subject.mediaId))) return null;
        const known = get().reports.get(subject.mediaId);
        // A cache hit on the wire too: `analyzeShotsFloor` reads the sidecar the
        // probe just found, so this is a file read and not a scan.
        return known ?? (await analyzeShotsFloor(subject.mediaId));
      },
      (report) => {
        if (!isSubject(subject)) return;
        if (report === null) {
          set({ cached: false, reduced: null });
          return;
        }
        set({
          cached: true,
          reports: new Map(get().reports).set(subject.mediaId, report),
        });
        void runReduce();
      },
    );
  } catch (err) {
    // A probe that cannot even be asked leaves the Panel offering Analyze —
    // the honest answer, since nothing is known to be on disk.
    console.warn("[shotsStore] floor-report probe failed", err);
    if (isSubject(subject)) set({ cached: false, reduced: null });
  }
}

/// Bind the Panel to a clip, or to nothing. Idempotent on an unchanged subject,
/// because the Panel calls it from an effect that re-runs on every summary tick.
export function setShotSubject(subject: ShotSubject | null): void {
  if (subject === null) {
    if (get().subject === null) return;
    sourceRequests.invalidate();
    reduceRequests.invalidate();
    set({ subject: null, cached: null, reduced: null, error: "" });
    return;
  }
  if (isSubject(subject)) return;
  set({ subject, cached: null, reduced: null, error: "" });
  void loadSubjectReport(subject);
}

/// Forget what is known about one source and ask again. The media pool's
/// "Analyze shots" is a cache warmer with no idea whether a Panel is open, so
/// this is how its success reaches an open one — the probe that follows finds
/// the report it just wrote.
export function invalidateShotSource(mediaId: string): void {
  const next = new Map(get().reports);
  next.delete(mediaId);
  set({ reports: next });
  const { subject } = get();
  if (subject === null || subject.mediaId !== mediaId) return;
  set({ cached: null, reduced: null });
  void loadSubjectReport(subject);
}

/// Run the whole-source floor scan for the current subject — the one path in
/// this module that can start a decode, and only a deliberate press reaches it.
///
/// `clipName` comes in rather than being derived here: naming the clip is
/// `layerDisplayName`'s job and it needs the active locale, which belongs to the
/// component and not to a store.
export async function analyzeShotSubject(clipName: string): Promise<void> {
  const { subject, analyzing } = get();
  if (subject === null || analyzing !== null) return;
  set({ analyzing: subject.mediaId, error: "" });
  // Minutes-long on a long source and there is no percentage to report — the
  // ffmpeg pass emits metadata lines, not progress — so the Started row is what
  // the status badge spins on. One `op_id` pairs it with the terminal row
  // (docs/status-log.md).
  const opId = crypto.randomUUID();
  void logEmit({
    level: "info",
    category: { kind: "Project" },
    source: { kind: "User" },
    message: `Analyzing shots in ${clipName}`,
    i18n_key: "log.shots_analyze_started",
    i18n_args: { clip: clipName },
    op_id: opId,
    op_state: { state: "Started" },
  });
  try {
    const report = await analyzeShotsFloor(subject.mediaId);
    set({
      reports: new Map(get().reports).set(subject.mediaId, report),
      analyzing: null,
    });
    if (isSubject(subject)) {
      set({ cached: true });
      await runReduce();
    }
    // The CANDIDATE count and not the shot count: the scan's product is the
    // candidate list, and how many shots come out of it is whatever the
    // threshold says next.
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `${report.cut_scores.length} shot candidates found in ${clipName}`,
      i18n_key: "log.shots_analyze_done",
      i18n_args: { clip: clipName, candidates: report.cut_scores.length },
      op_id: opId,
      op_state: { state: "Ok" },
    });
  } catch (err) {
    // The tool's own sentence, verbatim: a source with no probed duration
    // refuses with a re-import instruction, and that instruction is the whole
    // actionable half of the failure.
    set({ analyzing: null, error: refusalText(err) });
    // Terminated under the same `op_id` rather than left to
    // `logMutationFailure`'s standalone row: an unterminated op keeps the
    // status bar's running badge spinning forever, and the row carries the same
    // refusal `logMutationFailure` would have emitted.
    const refusal = describeRefusal(err);
    void logEmit({
      level: refusal?.level ?? "error",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: refusal?.message ?? `Shot analysis failed: ${String(err)}`,
      ...(refusal?.i18n_key
        ? { i18n_key: refusal.i18n_key, i18n_args: refusal.i18n_args ?? null }
        : {
            i18n_key: "log.shots_analyze_failed",
            i18n_args: { clip: clipName, error: refusalText(err) },
          }),
      op_id: opId,
      op_state: { state: "Err" },
      details: { context: "analyze_shots_floor", ...(refusal ? { error: refusal.error } : {}) },
    });
  }
}

/// Accept or veto one shot's opening candidate. A vetoed candidate merges its
/// shot into the predecessor (`shotRows.ts`); nothing is re-detected.
export function setCandidateAccepted(
  mediaId: string,
  candidateSrcUs: number,
  accepted: boolean,
): void {
  set({ vetoed: withKey(get().vetoed, mediaId, candidateSrcUs, !accepted) });
}

/// Keep or discard one row. Default is kept, so the plain apply is "split here".
export function setRowKept(
  mediaId: string,
  srcStartUs: number,
  keep: boolean,
): void {
  set({ discarded: withKey(get().discarded, mediaId, srcStartUs, !keep) });
}

/// Back to the pre-open state, so a reopened Panel never shows a review that
/// was abandoned — and never trusts a report against media that has been
/// relinked since.
export function resetShotsStore(): void {
  sourceRequests.invalidate();
  reduceRequests.invalidate();
  // `INITIAL`'s three maps are never mutated — every write above builds a new
  // one — so restoring them by reference is both correct and what keeps the
  // selectors from re-rendering on a reset that changed nothing.
  useShotsStore.setState({ ...INITIAL });
}

// ===== Atomic selector helpers ============================================
// One subscription each, every one yielding a stable reference: a selector that
// built a fresh object or array would re-render on every store tick and
// eventually loop (`feedback_zustand_composite_selector`).

export const useShotReduced = (): ShotReport | null =>
  useShotsStore((s) => s.reduced);

export const useShotCached = (): boolean | null => useShotsStore((s) => s.cached);

export const useShotAnalyzing = (): string | null =>
  useShotsStore((s) => s.analyzing);

export const useShotError = (): string => useShotsStore((s) => s.error);

export const useShotThreshold = (): number | null =>
  useShotsStore((s) => s.sensitivity);

export const useShotFloor = (): number | null => useShotsStore((s) => s.floor);

export const useShotMinShotUs = (): number | null =>
  useShotsStore((s) => s.minShotUs);

/// The FLOOR report for one source — every candidate the scan emitted, not the
/// reduce's survivors. The score strip draws from this one because its job is to
/// show what the line is currently EXCLUDING, and the reduced report has already
/// dropped exactly those.
export const useShotFloorReport = (mediaId: string | null): ShotReport | null =>
  useShotsStore((s) => (mediaId === null ? null : s.reports.get(mediaId) ?? null));

export const useVetoedCandidates = (mediaId: string | null): ReadonlySet<number> =>
  useShotsStore((s) => (mediaId === null ? NO_TIMES : s.vetoed.get(mediaId) ?? NO_TIMES));

export const useDiscardedRows = (mediaId: string | null): ReadonlySet<number> =>
  useShotsStore((s) =>
    mediaId === null ? NO_TIMES : s.discarded.get(mediaId) ?? NO_TIMES,
  );
