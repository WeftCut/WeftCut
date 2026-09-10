// The project-wide Role Mixer Panel and the single home for per-Role mute/solo.
// Boundary: it mixes the four canonical Audio Roles, never Tracks or per-Layer
// audio, and folds Role gain. Every meter here is a readout off the shared
// meter store — the master output and the per-Role taps alike — and never a DSP
// stage: the sampling lives at the audio graph's analysers. Docked narrow the
// Panel is a card list, docked wide a console of vertical faders; both are
// presentations of the one gain gesture `useRoleGain` owns. The recorded-gain /
// unrecorded-mute-solo model is documented in `docs/audio.md`.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MessagesSquareIcon,
  MicIcon,
  MusicIcon,
  RotateCcwIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { AppNumberField } from "../components/AppNumberField";
import { AppSlider } from "../components/AppSlider";
import { tryMutate } from "../errors/tryMutate";
import {
  AUDIO_ROLES,
  setRoleGain,
  updateRoleFlags,
  type AudioRole,
  type RoleMixView,
} from "../ipc";
import { useAudioRoles } from "../state/projectStore";
import {
  acquireRoleMeterDemand,
  SILENCE_DB,
  useMasterPeakDb,
  useMasterRmsDb,
  useRoleRmsDb,
} from "../state/masterMeterStore";
import { anyRoleSolo, roleAudible } from "../render/audio/roleGate";
import {
  clearRoleGainOverride,
  setRoleGainOverride,
} from "../render/audio/roleGainOverrides";

// Role gain range and step mirror the per-layer GAIN_DB descriptor so the mixer
// and the inspector agree on the same scale. 0 dB is the neutral/unity value the
// reset action restores (roleGate treats an absent Role as 0 dB).
const GAIN_MIN_DB = -30;
const GAIN_MAX_DB = 20;
const GAIN_STEP_DB = 0.5;
const NEUTRAL_GAIN_DB = 0;

/// Where a dB value sits along a fader's travel — 0 at the low end of the
/// track, 1 at the high end. This is the mapping the slider positions its thumb
/// from (a percentage of the track box, with the thumb's own centre translated
/// onto it), so anything drawn at this fraction against the SAME box coincides
/// with the thumb at that value. Both the card's unity tick and the console's
/// shared dB scale read off it.
function gainFraction(db: number): number {
  return (db - GAIN_MIN_DB) / (GAIN_MAX_DB - GAIN_MIN_DB);
}

/// Where the 0 dB mark sits along a fader's travel.
const UNITY_TICK_FRACTION = gainFraction(NEUTRAL_GAIN_DB);

/// The console's dB legend, drawn once in the shared gutter. 10 dB apart is as
/// dense as micro type gets over the fader's travel, and unity is one of the
/// ticks on purpose: it is the line all four faders share.
const DB_SCALE_TICKS = [20, 10, 0, -10, -20, -30];

// Root width at or above which the Panel is a console. It is the console's own
// floor, and it is arithmetic rather than an estimate because `editor.css` pins
// every console column: four 66px Role strips, the 58px master strip, the 26px
// dB gutter, five 4px gaps and the Panel's own 12px inset on each side. Below
// it the card list is the only layout that fits, and the card list is legible
// all the way down to `TOOL_MINIMUM`'s 240px, so there is no third branch.
const CONSOLE_LAYOUT_MIN_WIDTH = 392;

// The fill scale every meter on the Panel reads: -60 dBFS is the visual floor
// (0% fill) and 0 dBFS is full scale, for the master output and the per-Role
// taps alike. One floor on purpose — a Role bar and the master bar at the same
// level have to fill to the same fraction, or the Panel shows two scales and
// neither can be read against the other. (Silence is the store's `SILENCE_DB`
// sentinel, rendered "−∞".)
const METER_FLOOR_DB = -60;

type MixerLayout = "cards" | "console";

/// Role identity is a glyph, not a colour: four fixed Roles each claiming a hue
/// would spend the hue channel on identity and leave state without one. The
/// glyphs are decorative — the Role NAME beside one carries the identity, so a
/// reader who cannot tell the icons apart loses nothing.
const ROLE_GLYPH: Record<AudioRole, LucideIcon> = {
  dialogue: MessagesSquareIcon,
  music: MusicIcon,
  sfx: ZapIcon,
  voiceover: MicIcon,
};

/// One M/S toggle, styled to match the track header's flag buttons.
function MixerFlagButton({ active, activeClass, label, onToggle, children }: {
  active: boolean;
  activeClass: string;
  label: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
      className={`inline-flex size-[18px] items-center justify-center rounded-[4px] text-[9px] font-semibold transition-colors ${
        active ? activeClass : "text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/// The card's dB value: a button carrying the number and its unit at rest, an
/// `AppNumberField` once pressed. Both states take the SAME accessible name, so
/// the swap does not rename the control mid-edit.
function GainReadout({ label, value, onCommit }: {
  label: string;
  value: number;
  onCommit: (gainDb: number) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // Armed by Escape so the blur that follows the field's removal commits
  // nothing — the same shape as the fader's cancel guard below.
  const discardedRef = useRef(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  // Click-to-edit is only reachable if the field takes the keyboard on open.
  // `AppNumberField` forwards no ref, so reach its input through the wrapper.
  useEffect(() => {
    if (!editing) return;
    const input = fieldRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className="mixer-readout"
        aria-label={label}
        // A trimmed Role is marked on the readout itself rather than with a
        // badge of its own: the one badge either layout carries names implied
        // mute, and a second badge beside it would make two states compete.
        data-neutral={value === NEUTRAL_GAIN_DB}
        onClick={() => {
          discardedRef.current = false;
          setEditing(true);
        }}
      >
        {t("mixer.gain_value", { value })}
      </button>
    );
  }

  return (
    <div
      ref={fieldRef}
      className="mixer-readout-field"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Keep the discard local: the card also listens for Escape to abandon a
        // fader gesture, and closing the readout is not abandoning a drag.
        e.stopPropagation();
        discardedRef.current = true;
        setEditing(false);
      }}
    >
      <AppNumberField
        value={value}
        step={GAIN_STEP_DB}
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        align="center"
        ariaLabel={label}
        // No-op live change: Base UI self-buffers the typed text and commits on
        // blur/Enter. The fader drives `value`, so this field still reflects a
        // drag live.
        onValueChange={() => {}}
        onCommit={(gainDb) => {
          setEditing(false);
          if (discardedRef.current) return;
          onCommit(gainDb);
        }}
        onBlur={() => setEditing(false)}
      />
    </div>
  );
}

/// The whole Role gain gesture, in one place because the card and the console
/// strip are two presentations of it and must not become two behaviours. Owns a
/// shared gain draft so the fader and the readout track each other during an
/// edit (mirrors KeyframeField), the live audition override, the single
/// recorded commit, and Escape as abandon. Gain is recorded; mute/solo go
/// through the unrecorded `updateRoleFlags`.
function useRoleGain(
  role: AudioRole,
  mix: RoleMixView,
  onMutated: () => Promise<void>,
) {
  // null = idle (display the committed `mix.gain_db`, which tracks undo/redo); a
  // number while the fader is mid-drag. Both widgets read `value` and write the
  // draft, so a fader drag and the readout stay in sync. A non-null draft is
  // exactly "a fader audition is in flight".
  const [draft, setDraft] = useState<number | null>(null);
  // Set by Escape so the pointer-release `onValueCommitted` that still fires
  // after a cancel records nothing.
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      clearRoleGainOverride(role);
    },
    [role],
  );

  // Live audition: the fader drives the draft (so the readout mirrors it) and a
  // renderer-local Role override the Compositor's audio pass folds in place of
  // the committed gain — audible immediately, recorded nowhere.
  const audition = (gainDb: number) => {
    cancelledRef.current = false;
    setDraft(gainDb);
    setRoleGainOverride(role, gainDb);
  };
  // Commit exactly one recorded Role gain and drop the override so the audio
  // pass returns to the committed value. Shared by fader release, readout
  // blur/Enter, and reset.
  const commitGain = (gainDb: number) => {
    clearRoleGainOverride(role);
    setDraft(null);
    void tryMutate(
      () => setRoleGain(role, gainDb).then(onMutated),
      "Set role gain",
    );
  };
  // The fader's release. Swallows exactly the one release that follows an
  // Escape, then re-arms.
  const commitDrag = (gainDb: number) => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    commitGain(gainDb);
  };
  // Escape: abandon the gesture. Clear the override (restores the original
  // sound), drop the draft (restores the displayed value), and arm the guard so
  // the release commits nothing. Kept local so a global Escape handler does not
  // also fire.
  const cancelOnEscape = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || draft === null) return;
    e.stopPropagation();
    cancelledRef.current = true;
    clearRoleGainOverride(role);
    setDraft(null);
  };
  const flip = (patch: { muted?: boolean; solo?: boolean }) => () => {
    void tryMutate(
      () => updateRoleFlags(role, patch).then(onMutated),
      "Toggle role flag",
    );
  };

  return {
    value: draft ?? mix.gain_db,
    audition,
    commitGain,
    commitDrag,
    cancelOnEscape,
    flip,
  };
}

/// Mute and solo for one Role. State rather than actions, so both layouts keep
/// them at rest — the reset beside them is the action, and it hides.
function RoleFlags({ mix, roleLabel, flip }: {
  mix: RoleMixView;
  roleLabel: string;
  flip: (patch: { muted?: boolean; solo?: boolean }) => () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <MixerFlagButton
        active={mix.muted}
        activeClass="bg-red-500/20 text-red-300"
        label={t("mixer.mute_hint", { role: roleLabel })}
        onToggle={flip({ muted: !mix.muted })}
      >
        M
      </MixerFlagButton>
      <MixerFlagButton
        active={mix.solo}
        activeClass="bg-amber-500/25 text-amber-300"
        label={t("mixer.solo_hint", { role: roleLabel })}
        onToggle={flip({ solo: !mix.solo })}
      >
        S
      </MixerFlagButton>
    </>
  );
}

/// Return one Role to unity. Lives in the revealed `.mixer-actions` gutter in
/// both layouts: four reset icons standing at rest read as the Panel's subject,
/// and the subject is the mix.
function RoleResetButton({ roleLabel, onReset }: {
  roleLabel: string;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const label = t("mixer.reset_hint", { role: roleLabel });
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onReset}
      className="inline-flex size-[18px] items-center justify-center rounded-[4px] text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-foreground"
    >
      <RotateCcwIcon size={11} />
    </button>
  );
}

/// Names why a Role is silent when another Role's solo is what silenced it.
/// Dimming is the indication and this is the reason, so the state is explained
/// rather than merely shown; the full sentence is the badge's `title`. Shared by
/// both layouts because two copies of one explanation are two things to keep
/// saying the same, and this one is the widest thing either layout adds — the
/// line it lands on is a layout decision each presentation makes for itself.
function ImpliedMuteBadge({ roleLabel }: { roleLabel: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="mixer-implied-badge"
      title={t("mixer.implied_mute_hint", { role: roleLabel })}
    >
      {t("mixer.implied_mute_badge")}
    </span>
  );
}

/// What both layouts need to render one Role.
interface RoleControlProps {
  role: AudioRole;
  mix: RoleMixView;
  silencedBySolo: boolean;
  onMutated: () => Promise<void>;
}

/// One Role card: identity and readout on line 1, the fader spanning the card
/// on line 2, the Role's level meter on line 3, and its state and action on
/// line 4. Giving the fader a line of its own is the whole point — a fader that
/// shares a line with a value widget has no width left. The controls have a
/// line of their own for width rather than for grouping: the Role name is the
/// one item on the card that grows with a translation, and it only has room to
/// grow while the boxes sharing its line stay few — `.mixer-card-head` carries
/// that arithmetic.
function RoleChannel({ role, mix, silencedBySolo, onMutated }: RoleControlProps) {
  const { t } = useTranslation();
  const roleLabel = t(`audio_roles.${role}`);
  const Glyph = ROLE_GLYPH[role];
  const gain = useRoleGain(role, mix, onMutated);

  return (
    <div
      className="mixer-card"
      data-silenced={silencedBySolo}
      onKeyDown={gain.cancelOnEscape}
    >
      <div className="mixer-card-head">
        <Glyph className="mixer-role-glyph" size={13} aria-hidden />
        <span className="mixer-role-name">{roleLabel}</span>
        <GainReadout
          label={t("mixer.gain_db", { role: roleLabel })}
          value={gain.value}
          onCommit={gain.commitGain}
        />
      </div>
      <div className="mixer-card-fader">
        <span
          className="mixer-unity-tick"
          aria-hidden
          style={{ left: `${UNITY_TICK_FRACTION * 100}%` }}
        />
        <AppSlider
          className="mixer-fader"
          value={gain.value}
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={GAIN_STEP_DB}
          ariaLabel={t("mixer.gain_fader", { role: roleLabel })}
          getAriaValueText={(db) => t("mixer.gain_value", { value: db })}
          onValueChange={gain.audition}
          onValueCommitted={gain.commitDrag}
        />
      </div>
      <RoleMeter role={role} roleLabel={roleLabel} />
      <div className="mixer-card-controls">
        {silencedBySolo ? <ImpliedMuteBadge roleLabel={roleLabel} /> : null}
        <div className="mixer-card-flags">
          <RoleFlags mix={mix} roleLabel={roleLabel} flip={gain.flip} />
        </div>
        <div className="mixer-actions">
          <RoleResetButton
            roleLabel={roleLabel}
            onReset={() => gain.commitGain(NEUTRAL_GAIN_DB)}
          />
        </div>
      </div>
    </div>
  );
}

/// One console strip: the Role's glyph over its name, a vertical fader on the
/// travel the whole console shares, the readout, then mute/solo/reset. Vertical
/// is what makes the precision width-independent — a horizontal fader's travel
/// is a function of the dock width, and at the width this layout takes over it
/// was under one pixel per legal gain value.
function RoleStrip({ role, mix, silencedBySolo, onMutated }: RoleControlProps) {
  const { t } = useTranslation();
  const roleLabel = t(`audio_roles.${role}`);
  const Glyph = ROLE_GLYPH[role];
  const gain = useRoleGain(role, mix, onMutated);

  return (
    <div
      className="mixer-console-column mixer-strip"
      data-silenced={silencedBySolo}
      onKeyDown={gain.cancelOnEscape}
    >
      <div className="mixer-strip-head">
        <Glyph className="mixer-role-glyph" size={13} aria-hidden />
        <span className="mixer-role-name">{roleLabel}</span>
      </div>
      <div className="mixer-strip-fader">
        <span
          className="mixer-strip-unity"
          aria-hidden
          style={{ bottom: `${UNITY_TICK_FRACTION * 100}%` }}
        />
        <AppSlider
          orientation="vertical"
          className="mixer-console-fader"
          value={gain.value}
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={GAIN_STEP_DB}
          ariaLabel={t("mixer.gain_fader", { role: roleLabel })}
          getAriaValueText={(db) => t("mixer.gain_value", { value: db })}
          onValueChange={gain.audition}
          onValueCommitted={gain.commitDrag}
        />
      </div>
      <GainReadout
        label={t("mixer.gain_db", { role: roleLabel })}
        value={gain.value}
        onCommit={gain.commitGain}
      />
      <div className="mixer-strip-controls">
        <RoleFlags mix={mix} roleLabel={roleLabel} flip={gain.flip} />
        <div className="mixer-actions">
          <RoleResetButton
            roleLabel={roleLabel}
            onReset={() => gain.commitGain(NEUTRAL_GAIN_DB)}
          />
        </div>
      </div>
      {silencedBySolo ? <ImpliedMuteBadge roleLabel={roleLabel} /> : null}
    </div>
  );
}

/// The console's dB legend: one gutter for all four faders, because four copies
/// of one legend would be the Panel's loudest element. Ticks are placed by
/// `gainFraction` against the same box the fader tracks fill, so a tick and a
/// thumb at one value land on one line. `role="img"` names the whole legend
/// once instead of leaving a reader six loose numbers.
function DbScaleGutter() {
  const { t } = useTranslation();
  return (
    <div
      className="mixer-console-column mixer-db-gutter"
      role="img"
      aria-label={t("mixer.db_scale")}
    >
      <div className="mixer-db-scale">
        {DB_SCALE_TICKS.map((db) => (
          <span
            key={db}
            className="mixer-db-tick"
            data-unity={db === NEUTRAL_GAIN_DB}
            style={{ bottom: `${gainFraction(db) * 100}%` }}
          >
            {db}
          </span>
        ))}
      </div>
    </div>
  );
}

/// Fraction of the meter track a dBFS reading fills, floored at METER_FLOOR_DB.
function meterFill(db: number): number {
  if (db <= SILENCE_DB) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB)));
}

/// A dBFS reading as the meter prints it — "−∞" at or below the store's silence
/// sentinel, so true silence is unambiguous rather than a very small number.
function meterText(db: number): string {
  return db <= SILENCE_DB ? "−∞" : db.toFixed(1);
}

/// One Role's level, under its fader: which category of sound is loud right
/// now, per card. RMS on the same floor and silence sentinel as the master, so
/// the two readings mean one thing. There is no mute/solo branch here on
/// purpose — a gated Role's bus receives nothing, so it reads silence at the
/// analyser (`AudioGraph.roleMeterSnapshot`), and a UI-side special case would
/// only hide a meter that disagreed with what is audible. Peak stays a
/// master-only reading: this meter answers "how loud", and a second number on
/// a thin line costs more ink than it repays.
function RoleMeter({ role, roleLabel }: { role: AudioRole; roleLabel: string }) {
  const { t } = useTranslation();
  // Scalar subscription: a selector returning `{ rmsDb, peakDb }` would hand
  // `useSyncExternalStore` a fresh object every call and re-render this subtree
  // for as long as it is mounted.
  const rmsDb = useRoleRmsDb(role);
  return (
    <div
      className="mixer-role-meter"
      role="group"
      aria-label={t("mixer.role_meter", { role: roleLabel })}
    >
      <div className="mixer-role-meter-track" aria-hidden>
        {/* The ramp is on the track and the shade retreats from the loud end —
            the console's meter pattern, so a colour means one level. */}
        <div
          className="mixer-role-meter-shade"
          style={{ width: `${(1 - meterFill(rmsDb)) * 100}%` }}
        />
      </div>
      <span className="mixer-role-meter-value">{meterText(rmsDb)}</span>
    </div>
  );
}

/// The single real Master meter, on one line: RMS as the track's uncovered
/// ramp, peak as a tick on the same track, both numbers in one readout.
/// Subscribes to the shared master RMS/Peak store the preview audio graph
/// publishes to, rather than polling the Compositor.
function MasterMeter() {
  const { t } = useTranslation();
  const rmsDb = useMasterRmsDb();
  const peakDb = useMasterPeakDb();
  return (
    <div className="mixer-master" role="group" aria-label={t("mixer.master_meter")}>
      <span className="mixer-master-label">{t("mixer.master")}</span>
      <div className="mixer-meter-track">
        {/* The ramp is on the track and the shade retreats from the loud end
            — the same pattern as the Role meters and the console's columns, so
            a colour means one level. The ramp is its own clipped box because
            the peak tick beside it deliberately stands taller than the track. */}
        <div className="mixer-meter-ramp" aria-hidden>
          <div
            className="mixer-meter-shade"
            style={{ width: `${(1 - meterFill(rmsDb)) * 100}%` }}
          />
        </div>
        <div
          className="mixer-meter-peak"
          aria-hidden
          style={{ left: `${meterFill(peakDb) * 100}%` }}
        />
      </div>
      <span className="mixer-master-value">
        {t("mixer.master_levels", { rms: meterText(rmsDb), peak: meterText(peakDb) })}
      </span>
    </div>
  );
}

/// The same master reading as the console's fifth strip: two columns on the
/// travel the faders use, so output level and Role gains read on one axis. The
/// columns are RMS and peak — not left and right; the analyser reads combined
/// channels. Standing on a sunken surface is what says "not a Role" without
/// spending a label on it.
function MasterMeterStrip() {
  const { t } = useTranslation();
  const rmsDb = useMasterRmsDb();
  const peakDb = useMasterPeakDb();
  const columns = [
    { key: "rms", label: t("mixer.rms"), db: rmsDb },
    { key: "peak", label: t("mixer.peak"), db: peakDb },
  ];
  return (
    <div
      className="mixer-console-column mixer-strip mixer-strip--master"
      role="group"
      aria-label={t("mixer.master_meter")}
    >
      <span className="mixer-strip-head mixer-master-label">{t("mixer.master")}</span>
      <div className="mixer-master-row mixer-master-row--meters">
        {columns.map((column) => (
          <div key={column.key}>
            <div className="mixer-meter-column" aria-hidden>
              {/* The ramp is painted on the track and uncovered from the top,
                  so a colour means one level. */}
              <div
                className="mixer-meter-column-shade"
                style={{ height: `${(1 - meterFill(column.db)) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mixer-master-row">
        {columns.map((column) => (
          <span key={column.key} className="mixer-master-caption">
            {column.label}
          </span>
        ))}
      </div>
      <div className="mixer-master-row">
        {columns.map((column) => (
          <span key={column.key} className="mixer-master-reading">
            {meterText(column.db)}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface RoleMixerPanelProps {
  onMutated: () => Promise<void>;
  visible?: boolean;
}

export function RoleMixerPanel({ onMutated, visible = true }: RoleMixerPanelProps) {
  const { t } = useTranslation();
  const roles = useAudioRoles();
  const byRole = new Map(roles.map((r) => [r.role, r]));
  // Implied mute reads off the SAME predicate the audio pass gates with, so a
  // dimmed card and a silent Role cannot disagree.
  const anySolo = anyRoleSolo(roles);

  // Measure our own content width to choose the layout. No shared
  // ResizeObserver hook exists; inline the timeline's jsdom-guarded pattern (the
  // observer is absent under jsdom, so the synchronous initial measure carries
  // the tests).
  const rootRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setWidth((prev) => (prev === w ? prev : w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout: MixerLayout = width >= CONSOLE_LAYOUT_MIN_WIDTH ? "console" : "cards";

  // The per-Role tap samples fast enough to read as a meter, so it runs only
  // while someone is looking at it: a Panel nobody has open spends no frame
  // budget. The lease is ref-counted and its release idempotent, so a second
  // holder (or the double mount StrictMode performs) is safe as long as each
  // acquire is matched by exactly one cleanup — which is what returning the
  // release straight out of the effect guarantees.
  useEffect(() => {
    if (!visible) return;
    return acquireRoleMeterDemand();
  }, [visible]);

  // One Role list for both layouts: the four canonical Roles, each with its
  // committed mix and its gate state, so the two presentations cannot disagree
  // about what they are showing.
  const channels = AUDIO_ROLES.map((role: AudioRole) => {
    const mix: RoleMixView = byRole.get(role) ?? {
      role,
      gain_db: 0,
      muted: false,
      solo: false,
    };
    return {
      role,
      mix,
      // Mute wins over solo, so a Role that muted itself is not "implicitly"
      // anything — it reads muted, not dimmed.
      silencedBySolo: !mix.muted && !roleAudible(role, roles, anySolo),
    };
  });

  return (
    <section
      ref={rootRef}
      className={`mixer-panel mixer-panel--${layout}`}
      aria-label={t("mixer.title")}
    >
      {layout === "console" ? (
        <div className="mixer-console">
          <DbScaleGutter />
          {channels.map((channel) => (
            <RoleStrip key={channel.role} {...channel} onMutated={onMutated} />
          ))}
          {visible ? <MasterMeterStrip /> : null}
        </div>
      ) : (
        <>
          <div className="mixer-roles">
            {channels.map((channel) => (
              <RoleChannel key={channel.role} {...channel} onMutated={onMutated} />
            ))}
          </div>
          {visible ? <MasterMeter /> : null}
        </>
      )}
    </section>
  );
}
