import { open as openDialog } from "@/bridge/dialog";
import { documentDir } from "@/bridge/path";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { validateProjectName } from "../../shared/newProject";
import type { TimelineImportPreview } from "../../shared/timelineImport";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { projectImportTimeline, projectNewWorkspace, recentsLastNewProjectParent } from "../ipc";
import { DEFAULT_CANVAS, FPS_OPTIONS, RESOLUTION_PRESETS, canvasSizeError, fpsLabel, resolutionLabel } from "./canvasPresets";
import { describeCreateError } from "./openError";

/// Join a parent folder + project name into a full path. Picks the
/// separator from whatever the parent uses (`\` if it contains one,
/// else `/`); defaults to `\` since the primary target is Windows.
function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") ? "\\" : parent.includes("/") ? "/" : "\\";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

export function NewProjectForm({
  onCancel,
  onCreated,
  onReviewTimeline,
  timeline,
}: {
  onCancel: () => void;
  onCreated: () => void;
  onReviewTimeline?: () => Promise<void>;
  timeline?: TimelineImportPreview;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(timeline?.name ?? "");
  const [parentFolder, setParentFolder] = useState<string>("");
  /// Size and rate are authored separately, exactly as Settings › Canvas does it:
  /// they are independent decisions (a 4K project is not automatically a 60 fps
  /// one), and the cross product of the two ladders is 48 entries nobody wants to
  /// scroll. `DEFAULT_CANVAS` is the opening pair both surfaces agree on.
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_CANVAS.width,
    height: DEFAULT_CANVAS.height,
  });
  const [customSize, setCustomSize] = useState(false);
  const [fps, setFps] = useState<{ num: number; den: number }>({
    num: DEFAULT_CANVAS.fpsNum,
    den: DEFAULT_CANVAS.fpsDen,
  });
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // First-launch: ask the backend for the last-used parent. If the
  // user never created a project before, fall back to the OS Documents
  // directory so they don't start at `C:\Users\<name>\`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const last = await recentsLastNewProjectParent();
        if (cancelled) return;
        if (last) {
          setParentFolder(last);
          return;
        }
        const docs = await documentDir();
        if (cancelled) return;
        if (docs) setParentFolder(docs);
      } catch {
        // Leave parentFolder empty; the picker still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickParent = useCallback(async () => {
    const picked = await openDialog({
      title: t("new_project.pick_parent_title"),
      directory: true,
      multiple: false,
      ...(parentFolder ? { defaultPath: parentFolder } : {}),
    });
    if (typeof picked === "string") {
      setParentFolder(picked);
      setSubmitError(null);
    }
  }, [t, parentFolder]);

  const nameValidationKey = validateProjectName(name);
  /// Same rule as Settings › Canvas, from the same validator. There is no Apply
  /// button here to hold a bad size back — nothing exists until Create — so an
  /// invalid size gates Create instead.
  const sizeFault = customSize ? canvasSizeError(size.width, size.height) : null;
  const sizeError =
    sizeFault === null ? null : t(sizeFault.key, sizeFault.params ?? {});
  const resolutionValue = customSize
    ? "custom"
    : `${size.width}x${size.height}`;
  const canCreate =
    !busy && !nameValidationKey && parentFolder.length > 0 && sizeError === null;
  const previewPath = name.trim() && parentFolder
    ? joinPath(parentFolder, name.trim())
    : null;

  const submit = useCallback(async () => {
    if (!canCreate) return;
    setBusy(true);
    setSubmitError(null);
    try {
      if (timeline) {
        await projectImportTimeline(timeline.id, "fit", { parentFolder, name: name.trim() }, {
          acceptMediaChanges: timeline.mediaChanges.length > 0 || timeline.outputColorChange !== null,
          acceptOmittedEffects: timeline.omittedEffects.length > 0,
          acceptTitleGaps: timeline.omittedTitles.length > 0,
          acceptShortAudioOmissions: timeline.omittedShortAudio.length > 0,
          acceptMediaGaps: timeline.mediaGaps.length > 0,
        });
      } else {
        await projectNewWorkspace({
          parentFolder,
          name: name.trim(),
          canvas: {
            width: size.width,
            height: size.height,
            fpsNum: fps.num,
            fpsDen: fps.den,
          },
        });
      }
      onCreated();
    } catch (e) {
      // The refusal carries no path — main composed the same target this dialog
      // is already previewing — so hand the copy map that, not a parsed-back one.
      setSubmitError(describeCreateError(e, previewPath ?? "", t));
      setBusy(false);
    }
  }, [canCreate, parentFolder, name, size, fps, previewPath, t, onCreated, timeline]);

  return (
    <AppDialog
      title={t(timeline ? "startup.import_timeline_project" : "new_project.title")}
      onClose={busy ? undefined : onCancel}
      showClose={false}
      panelClassName="new-project-panel"
    >
        <label className="new-project-row">
          <span>{t("new_project.name")}</span>
          <AppInput
            value={name}
            placeholder={t("new_project.name_placeholder")}
            ariaLabel={t("new_project.name")}
            onValueChange={setName}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) {
                e.preventDefault();
                void submit();
              }
            }}
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          {nameValidationKey && name.length > 0 && (
            <span className="new-project-validation">
              {t(nameValidationKey)}
            </span>
          )}
        </label>

        <div className="new-project-row">
          <span>{t("new_project.parent_folder")}</span>
          <div className="new-project-folder">
            <span
              className="new-project-folder-path"
              title={parentFolder}
            >
              {parentFolder || t("new_project.parent_folder_placeholder")}
            </span>
            <Button onClick={pickParent} disabled={busy}>
              {t("new_project.choose_folder")}
            </Button>
          </div>
        </div>

        {previewPath && (
          <p className="new-project-preview" title={previewPath}>
            <span aria-hidden="true">→ </span>
            {previewPath}
          </p>
        )}

        {timeline ? (
          <p>{t("startup.timeline_review_format", {
            width: timeline.width, height: timeline.height,
            rate: fpsLabel(timeline.fps, t), frames: timeline.durationFrames,
          })}</p>
        ) : <>
        <div className="new-project-row">
          <span>{t("new_project.resolution")}</span>
          <AppSelect
            value={resolutionValue}
            onValueChange={(v) => {
              // Custom is a MODE, not a size: it reveals the fields and keeps
              // whatever size was last shown as their starting point.
              if (v === "custom") {
                setCustomSize(true);
                return;
              }
              setCustomSize(false);
              const [w, h] = v.split("x");
              setSize({ width: Number(w), height: Number(h) });
            }}
            disabled={busy}
            ariaLabel={t("new_project.resolution")}
            options={[
              ...RESOLUTION_PRESETS.map((r) => ({
                value: `${r.width}x${r.height}`,
                label: resolutionLabel(r),
              })),
              { value: "custom", label: t("new_project.resolution_custom") },
            ]}
          />
        </div>

        {customSize && (
          <div className="new-project-row">
            <span>{t("new_project.custom_size")}</span>
            <div className="new-project-size-fields">
              {/* Deliberately NO min/max on the fields, for the reason Settings ›
                  Canvas gives: Base UI clamps the value it reports while leaving the
                  typed text alone, so a typed 9000 would read 9000 and create 7680.
                  One authority (the validator), one visible message. */}
              <AppNumberField
                value={size.width}
                disabled={busy}
                step={2}
                align="center"
                ariaLabel={t("new_project.width")}
                onValueChange={(v) => setSize((s) => ({ ...s, width: v }))}
              />
              <span aria-hidden="true">×</span>
              <AppNumberField
                value={size.height}
                disabled={busy}
                step={2}
                align="center"
                ariaLabel={t("new_project.height")}
                onValueChange={(v) => setSize((s) => ({ ...s, height: v }))}
              />
            </div>
            {sizeError !== null && (
              <span className="new-project-validation" role="alert">
                {sizeError}
              </span>
            )}
          </div>
        )}

        <div className="new-project-row">
          <span>{t("new_project.frame_rate")}</span>
          <AppSelect
            value={`${fps.num}/${fps.den}`}
            onValueChange={(v) => {
              const [num, den] = v.split("/");
              setFps({ num: Number(num), den: Number(den) });
            }}
            disabled={busy}
            ariaLabel={t("new_project.frame_rate")}
            options={FPS_OPTIONS.map((f) => ({
              value: `${f.num}/${f.den}`,
              label: fpsLabel(f, t),
            }))}
          />
        </div>

        </>}

        {submitError && (
          <p className="new-project-error" role="alert">{submitError}</p>
        )}

        <footer className="new-project-actions">
          <Button size="lg" onClick={onCancel} disabled={busy}>
            {t("new_project.cancel")}
          </Button>
          {onReviewTimeline && submitError && (
            <Button size="lg" onClick={() => void onReviewTimeline()} disabled={busy}>
              {t("startup.import_refresh_review")}
            </Button>
          )}
          <Button
            variant="default"
            size="lg"
            onClick={submit}
            disabled={!canCreate}
          >
            {busy ? t("new_project.creating") : t("new_project.create")}
          </Button>
        </footer>
    </AppDialog>
  );
}
