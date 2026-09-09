// The project-wide Role Mixer Panel and the single home for per-Role mute/solo.
// Boundary: it mixes the four canonical Audio Roles, never Tracks or per-Layer
// audio, and folds Role gain — no real per-Role buses or meters live here. The
// only meter is the real master RMS/Peak read off the shared store. The
// recorded-gain / unrecorded-mute-solo model is documented in `docs/audio.md`.

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
  SILENCE_DB,
  useMasterPeakDb,
  useMasterRmsDb,
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

/// Where the 0 dB mark sits along a fader's travel — the same min/max mapping
/// the slider thumb is positioned from, so tick and thumb coincide at unity.
const UNITY_TICK_FRACTION =
  (NEUTRAL_GAIN_DB - GAIN_MIN_DB) / (GAIN_MAX_DB - GAIN_MIN_DB);

// At/above this content width the cards get the wide treatment; below it they
// stay in the narrow flow. The card list works at either width — the switch is
// here for the console the wide branch grows into, and its threshold belongs to
// that console's lower bound.
const CONSOLE_LAYOUT_MIN_WIDTH = 360;

// Master meter fill scale: -60 dBFS is the visual floor (0% fill), 0 dBFS is
// full scale. (Silence is the store's `SILENCE_DB` sentinel, rendered "−∞".)
const METER_FLOOR_DB = -60;

type MixerLayout = "cards" | "cards-wide";

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
        // Marks a trimmed Role on the readout itself; the badge slot beside it
        // belongs to implied mute.
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

/// One Role card: identity, readout and flags on line 1, the fader spanning the
/// card on line 2. The second line is the whole point — a fader that shares a
/// line with a value widget has no width left. Owns a shared gain draft so the
/// fader and the readout track each other during an edit (mirrors KeyframeField).
/// Gain is recorded; mute/solo go through the unrecorded `updateRoleFlags`.
function RoleChannel({ role, mix, silencedBySolo, onMutated }: {
  role: AudioRole;
  mix: RoleMixView;
  silencedBySolo: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const roleLabel = t(`audio_roles.${role}`);
  const Glyph = ROLE_GLYPH[role];
  // null = idle (display the committed `mix.gain_db`, which tracks undo/redo); a
  // number while the fader is mid-drag. Both widgets read `value` and write the
  // draft, so a fader drag and the readout stay in sync. A non-null draft is
  // exactly "a fader audition is in flight".
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? mix.gain_db;
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
  // Escape: abandon the gesture. Clear the override (restores the original
  // sound), drop the draft (restores the displayed value), and arm the guard so
  // the release commits nothing.
  const cancelGesture = () => {
    if (draft === null) return;
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

  return (
    <div
      className="mixer-card"
      data-silenced={silencedBySolo}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || draft === null) return;
        // Keep the cancel local — don't let a global Escape handler also fire.
        e.stopPropagation();
        cancelGesture();
      }}
    >
      <div className="mixer-card-head">
        <Glyph className="mixer-role-glyph" size={13} aria-hidden />
        <span className="mixer-role-name">{roleLabel}</span>
        <GainReadout
          label={t("mixer.gain_db", { role: roleLabel })}
          value={value}
          onCommit={commitGain}
        />
        {silencedBySolo ? (
          <span
            className="mixer-implied-badge"
            title={t("mixer.implied_mute_hint", { role: roleLabel })}
          >
            {t("mixer.implied_mute_badge")}
          </span>
        ) : null}
        <div className="mixer-card-flags">
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
        </div>
        <div className="mixer-card-actions">
          <button
            type="button"
            title={t("mixer.reset_hint", { role: roleLabel })}
            aria-label={t("mixer.reset_hint", { role: roleLabel })}
            onClick={() => commitGain(NEUTRAL_GAIN_DB)}
            className="inline-flex size-[18px] items-center justify-center rounded-[4px] text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-foreground"
          >
            <RotateCcwIcon size={11} />
          </button>
        </div>
      </div>
      <div className="mixer-card-fader">
        <span
          className="mixer-unity-tick"
          aria-hidden
          style={{ left: `${UNITY_TICK_FRACTION * 100}%` }}
        />
        <AppSlider
          className="mixer-fader"
          value={value}
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          step={GAIN_STEP_DB}
          ariaLabel={t("mixer.gain_fader", { role: roleLabel })}
          onValueChange={audition}
          onValueCommitted={(gainDb) => {
            if (cancelledRef.current) {
              cancelledRef.current = false;
              return;
            }
            commitGain(gainDb);
          }}
        />
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

/// The single real Master meter, on one line: RMS as the track fill, peak as a
/// tick on the same track, both numbers in one readout. Subscribes to the shared
/// master RMS/Peak store the preview audio graph publishes to, rather than
/// polling the Compositor.
function MasterMeter() {
  const { t } = useTranslation();
  const rmsDb = useMasterRmsDb();
  const peakDb = useMasterPeakDb();
  return (
    <div className="mixer-master" role="group" aria-label={t("mixer.master_meter")}>
      <span className="mixer-master-label">{t("mixer.master")}</span>
      <div className="mixer-meter-track">
        <div
          className="mixer-meter-fill"
          style={{ width: `${meterFill(rmsDb) * 100}%` }}
        />
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

  // Measure our own content width to choose the card list's treatment. No shared
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
  const layout: MixerLayout = width >= CONSOLE_LAYOUT_MIN_WIDTH ? "cards-wide" : "cards";

  return (
    <section
      ref={rootRef}
      className={`mixer-panel mixer-panel--${layout}`}
      aria-label={t("mixer.title")}
    >
      <div className="mixer-roles">
        {AUDIO_ROLES.map((role: AudioRole) => {
          const mix = byRole.get(role) ?? { role, gain_db: 0, muted: false, solo: false };
          return (
            <RoleChannel
              key={role}
              role={role}
              mix={mix}
              // Mute wins over solo, so a Role that muted itself is not
              // "implicitly" anything — it reads muted, not dimmed.
              silencedBySolo={!mix.muted && !roleAudible(role, roles, anySolo)}
              onMutated={onMutated}
            />
          );
        })}
      </div>
      {visible ? <MasterMeter /> : null}
    </section>
  );
}
