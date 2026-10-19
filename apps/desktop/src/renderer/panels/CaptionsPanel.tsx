// Captions panel — the Project-wide caption corpus surface. It flattens the
// cues of EVERY caption-role Track (`role === "caption"`) in start-time order,
// including overlapping lanes, and exposes them as one editable cue list.
// Activating a cue selects its Text Layer, seeks the playhead to its start, and
// reveals it in Timeline (composed by the host via `onActivateCue`). Inline text
// editing still updates a single ordinary Text Layer. The style controls — size,
// outline width, colour — restyle the WHOLE corpus, every caption-role Track, in
// one atomic undo entry. Outline width 0 means no outline: it is the one style
// the default caption look adds beyond the file's own, so the row that sets its
// weight is also the row that takes it off.
// Each caption cue is a first-class Text Layer built by `apply_subtitles` (a
// pooled subtitle document) or `apply_transcripts` (a transcription).

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { tryMutate } from "../errors/tryMutate";
import { useOpenComposition } from "../state/projectStore";
import { AppColorField, hexToRgba, rgbaToHex } from "../components/AppColorField";
import { AppNumberField } from "../components/AppNumberField";
import { TextCorrectionDialog } from "../speech/TextCorrectionDialog";
import { Button } from "../components/ui/button";
import { useProjectStore } from "../state/projectStore";
import { ComputeJobStatus } from "../compute/ComputeJobStatus";
import { useComputeJobsStore } from "../compute/computeJobsStore";
import type { ComputeJobSubject } from "../compute/computeJobView";
import { layerDisplayName } from "../lib/layerName";
import { useTranscribeRunStore } from "../speech/transcribeRun";
import "../compute/compute.css";
import {
  updateLayerParams,
  restyleCaptions,
  trackStatic,
  type CompositionSummary,
  type LayerSummary,
  type Rgba,
} from "../ipc";

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/// One flattened caption cue plus the caption-role Track that owns it. The
/// track id is what `onActivateCue` reveals in Timeline.
interface CaptionCue {
  layer: LayerSummary;
  trackId: string;
}

export interface CaptionPanelProps {
  onMutated: () => Promise<void>;
  /// The primary selected Layer — highlights the matching cue row.
  selectedLayerId?: string | null;
  /// Activate a cue: select its Text Layer, seek to its start, and reveal it in
  /// Timeline.
  onActivateCue: (layerId: string, trackId: string, startUs: number) => void;
}

function CaptionCueRow({
  cue,
  selected,
  onActivate,
  onCommit,
}: {
  cue: CaptionCue;
  selected: boolean;
  onActivate: (cue: CaptionCue) => void;
  onCommit: (layerId: string, content: string) => void;
}) {
  const { t } = useTranslation();
  const { layer } = cue;
  const content = layer.params.kind === "Text" ? layer.params.content : "";
  const [draft, setDraft] = useState(content);

  // Undo/redo and external edits replace the authoritative cue content. Keep
  // the input draft aligned whenever that value changes; ordinary keystrokes
  // only update local state and therefore are not disturbed.
  useEffect(() => setDraft(content), [content]);

  return (
    <li className={`caption-row ${selected ? "is-selected" : ""}`}>
      <button
        type="button"
        className="caption-seek"
        onClick={() => onActivate(cue)}
        aria-label={t("captions.seek_to", { timecode: fmtTc(layer.t_start_us) })}
      >
        {fmtTc(layer.t_start_us)}
      </button>
      <input
        className="app-input caption-text"
        value={draft}
        aria-label={`${t("captions.title")} ${fmtTc(layer.t_start_us)}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== content) onCommit(layer.id, draft);
        }}
      />
    </li>
  );
}

/// The captions on their way: a line per transcription job reading a clip of
/// this composition — a person's or an agent's — naming the clip, with the
/// job's phase and Cancel, then "Adding captions" while a finished run writes
/// its cues (ADR 0121). The list below fills when the write lands; until then
/// this is what says something is coming, and what it is waiting for.
///
/// Its own component, so the job mirror's updates re-render this line and not
/// every cue row.
function CaptionsComputeStatus({ comp }: { comp: CompositionSummary | null }) {
  const { t } = useTranslation();
  const jobs = useComputeJobsStore((s) => s.jobs);
  const applying = useTranscribeRunStore((s) => s.applying);
  const ordinals = useProjectStore((s) => s.groupOrdinals);
  if (comp === null) return null;
  const here = new Map<string, LayerSummary>();
  for (const track of comp.tracks) for (const layer of track.layers) here.set(layer.id, layer);
  const running = Object.values(jobs)
    .filter((job) => job.tool === "transcribe_clip" && here.has(job.layer_id))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const writing = (applying ?? []).filter((id) => here.has(id));
  if (running.length === 0 && writing.length === 0) return null;
  const name = (id: string) => layerDisplayName(here.get(id)!, t, ordinals);
  return (
    <div className="captions-compute" data-testid="captions-compute">
      {running.map((job) => (
        <div className="captions-compute-line" key={job.job_id}>
          <span className="captions-compute-clip" title={name(job.layer_id)}>{name(job.layer_id)}</span>
          <ComputeJobStatus job={job} variant="inline" />
        </div>
      ))}
      {writing.length > 0 && (
        <div className="captions-compute-line" key="applying">
          <span className="captions-compute-clip" title={writing.map(name).join(", ")}>
            {writing.map(name).join(", ")}
          </span>
          <ApplyingStatus />
        </div>
      )}
    </div>
  );
}

/// The write-back's line. Not a job, so it has no Cancel and its "since" is
/// when this line appeared.
function ApplyingStatus() {
  const [since] = useState(() => new Date().toISOString());
  const subject: ComputeJobSubject = {
    job_id: "applying",
    tool: "transcribe_clip",
    phase: { kind: "applying" },
    phase_since: since,
  };
  return <ComputeJobStatus job={subject} variant="inline" hideCancel />;
}

export function CaptionPanel({ onMutated, selectedLayerId, onActivateCue }: CaptionPanelProps) {
  const { t } = useTranslation();
  const comp = useOpenComposition();
  const projectId = useProjectStore(s => s.summary?.project_id);
  const [correctionProject, setCorrectionProject] = useState<string | null>(null);

  const captionTracks = (comp?.tracks ?? []).filter((tr) => tr.role === "caption");

  // Flatten every caption-role track's Text layers in start-time order,
  // carrying the owning track id so activation can reveal the right lane.
  const cues: CaptionCue[] = captionTracks
    .flatMap((tr) => tr.layers.filter((l) => l.params.kind === "Text").map((layer) => ({ layer, trackId: tr.id })))
    .sort((a, b) => a.layer.t_start_us - b.layer.t_start_us);

  // Seed style controls from the first Text layer on the first caption track.
  const firstTextParams =
    captionTracks[0]?.layers.find((l) => l.params.kind === "Text")?.params;
  const seedSize =
    firstTextParams?.kind === "Text" ? firstTextParams.font_size_px : 54;
  const seedColor =
    firstTextParams?.kind === "Text"
      ? trackStatic(firstTextParams.color, WHITE)
      : WHITE;
  // An absent outline reads as 0, which is also what commits one away — the
  // field and the store agree on one representation of "none".
  const seedOutline =
    firstTextParams?.kind === "Text" ? (firstTextParams.outline?.width ?? 0) : 0;

  const [fontSize, setFontSize] = useState(seedSize);
  const [color, setColor] = useState(seedColor);
  const [outlineWidth, setOutlineWidth] = useState(seedOutline);
  // Debounce slot for caption color commits — the native color picker fires
  // onChange continuously; each IPC call creates a history entry, so we must
  // coalesce bursts into one commit per gesture.
  const colorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Undo/redo and external edits can restyle the same track without changing
  // its id, so synchronize from the actual seed values.
  useEffect(() => {
    setFontSize(seedSize);
    setColor(seedColor);
    setOutlineWidth(seedOutline);
  }, [seedSize, seedOutline, seedColor.r, seedColor.g, seedColor.b, seedColor.a]);

  // Clear any pending debounced color commit on unmount so a late call can't
  // fire after the component is gone.
  useEffect(() => {
    return () => {
      if (colorDebounceRef.current) clearTimeout(colorDebounceRef.current);
    };
  }, []);

  const commitText = async (layerId: string, content: string) => {
    if (
      await tryMutate(
        () => updateLayerParams(layerId, { kind: "Text", content }),
        "Edit caption",
      )
    ) {
      await onMutated();
    }
  };

  const activateCue = ({ layer, trackId }: CaptionCue) => {
    onActivateCue(layer.id, trackId, layer.t_start_us);
  };

  return (
    <section className="captions-panel" aria-label={t("captions.title")}>
      {projectId && correctionProject === projectId && <TextCorrectionDialog key={projectId} onClose={() => setCorrectionProject(null)} onMutated={onMutated} />}
      <section className="captions-style-section" aria-label={t("captions.style_heading")}>
        <div className="captions-toolbar-heading">
          <h4>{t("captions.style_heading")}</h4>
          <Button variant="outline" disabled={!projectId} onClick={() => setCorrectionProject(projectId ?? null)}>{t('text_correction.title')}</Button>
        </div>
        <div className="captions-style-fields">
          <div className="captions-style-control">
            <span className="captions-style-label">{t("captions.size_label")}</span>
            <AppNumberField
              disabled={!cues.length}
              value={fontSize}
              step={1}
              min={6}
              max={400}
              ariaLabel={t("property_panel.font_size_px")}
              onValueChange={setFontSize}
              onCommit={(v) =>
                void tryMutate(
                  () => restyleCaptions({ font_size_px: v }).then(onMutated),
                  "Restyle captions",
                )
              }
            />
          </div>
          <div className="captions-style-control">
            <span className="captions-style-label">{t("captions.outline_label")}</span>
            <AppNumberField
              disabled={!cues.length}
              value={outlineWidth}
              step={1}
              min={0}
              max={64}
              ariaLabel={t("captions.outline_width")}
              onValueChange={setOutlineWidth}
              onCommit={(v) =>
                void tryMutate(
                  () => restyleCaptions({ outline_width: v }).then(onMutated),
                  "Restyle captions",
                )
              }
            />
          </div>
          <AppColorField
            disabled={!cues.length}
            value={rgbaToHex(color)}
            ariaLabel={t("property_panel.color")}
            onValueChange={(hex) => {
              const next = hexToRgba(hex, color.a);
              setColor(next);
              if (colorDebounceRef.current) clearTimeout(colorDebounceRef.current);
              colorDebounceRef.current = setTimeout(() => {
                void tryMutate(
                  () => restyleCaptions({ color: next }).then(onMutated),
                  "Restyle captions",
                );
              }, 250);
            }}
          />
        </div>
      </section>
      <CaptionsComputeStatus comp={comp} />
      {cues.length === 0 ? (
        <p className="placeholder">{t("captions.empty")}</p>
      ) : (
        <ul className="captions-list">
          {cues.map((cue) => (
            <CaptionCueRow
              key={cue.layer.id}
              cue={cue}
              selected={cue.layer.id === selectedLayerId}
              onActivate={activateCue}
              onCommit={commitText}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/// Format microseconds as MM:SS for the cue timecode label.
function fmtTc(us: number): string {
  const s = Math.floor(us / 1_000_000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
