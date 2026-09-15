import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CONTENT_EVENTS,
  contentCancel,
  contentEnqueue,
  contentList,
  contentOpenFolder,
  contentQueue,
  contentRemove,
  type ContentListRow,
  type ContentQueueEntry,
  type ContentQueueSnapshot,
} from "../ipc";
import { listen, type UnlistenFn } from "@/bridge/events";
import { Button } from "@/components/ui/button";

/// The ADR 0039 download affordance for one local engine, rendered inside its
/// config row — a speech backend's `LocalBackendRow`, or (ADR 0055) a VLM
/// backend's `VlmLocalRow`. Renders nothing unless the catalog covers this
/// backend on this platform, so manual-path-only engines (MiniCPM-V today) and
/// uncovered OSes see no change.
///
/// A PROJECTION of main-process state, nothing more: the download queue lives
/// in main (contentQueue.ts), so this component can unmount mid-stream, remount
/// later, or be reloaded without touching a transfer. It renders from two
/// inputs — `content:list` rows (what is on disk) and the queue snapshot (what
/// is on its way) — and owns no phase of its own. One button enqueues the whole
/// missing set; while anything is pending the button becomes Cancel and each
/// pending item shows its state beneath it; once everything is installed the
/// row collapses to a managed-content caption with Open folder / Remove.
/// Downloaded paths land in the row's pickers via the main-process auto-fill →
/// `onChanged` re-fetch, never by this component writing config itself.
///
/// `family` picks which consumer tag to match, and it is a discriminator rather
/// than one merged predicate because the two catalog shapes genuinely differ:
/// a speech item names ONE backend, a VLM item names a LIST (one
/// `llama-mtmd-cli` serves both local vision engines).

export function ManagedContent({
  family,
  backend,
  onChanged,
  onError,
}: {
  family: "speech" | "vlm";
  backend: string;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ContentListRow[] | null>(null);
  const [queue, setQueue] = useState<ContentQueueSnapshot | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  /// Pending entries of THIS backend at the last snapshot — a drop means an
  /// item finished (installed or cancelled) and both surfaces must re-read.
  const pendingCountRef = useRef(0);

  const isMine = (r: ContentListRow): boolean =>
    family === "speech"
      ? r.item.speech?.backend === backend
      : (r.item.vlm?.backends.includes(backend as "qwen3_vl" | "minicpm_v") ??
        false);

  const refresh = async () => {
    try {
      const all = await contentList();
      setRows(all.filter(isMine));
    } catch (e) {
      onError(String(e));
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      await refresh();
      try {
        const snapshot = await contentQueue();
        if (!disposed) setQueue(snapshot);
      } catch (e) {
        onError(String(e));
      }
      unlisten = await listen<ContentQueueSnapshot>(
        CONTENT_EVENTS.queue,
        (e) => {
          if (!disposed) setQueue(e.payload);
        },
      );
      // Unmounted while the subscription was being set up.
      if (disposed) unlisten();
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [family, backend]);

  // A finished item (installed OR cancelled) leaves the pending set; the disk
  // rows and the parent's config view are both stale at that moment.
  useEffect(() => {
    if (!queue || !rows) return;
    const ids = new Set(rows.map((r) => r.item.id));
    const pending = queue.entries.filter(
      (e) => ids.has(e.itemId) && e.state !== "error",
    ).length;
    const previous = pendingCountRef.current;
    pendingCountRef.current = pending;
    if (pending < previous) {
      void (async () => {
        await refresh();
        await onChanged();
      })();
    }
  }, [queue, rows]);

  if (rows === null) return null;
  const covered = rows.filter((r) => r.status.state !== "unavailable");
  if (covered.length === 0) return null;

  const ids = new Set(covered.map((r) => r.item.id));
  const entries = (queue?.entries ?? []).filter((e) => ids.has(e.itemId));
  const active = entries.filter((e) => e.state !== "error");
  const failed = entries.find((e) => e.state === "error");
  const missing = covered.filter(
    (r) => r.status.state === "not_installed" || r.status.state === "corrupt",
  );
  const hasCorrupt = covered.some((r) => r.status.state === "corrupt");
  // Every covered row on disk — `downloading`/`queued` rows are NOT installed,
  // so a set with its last item in flight never reads as complete.
  const allInstalled = covered.every((r) => r.status.state === "installed");
  const prereqKeys = [
    ...new Set(
      covered
        .map((r) => r.prerequisiteKey)
        .filter((k): k is string => k !== undefined),
    ),
  ];

  const download = async () => {
    onError("");
    setBusy(true);
    try {
      setQueue(await contentEnqueue(missing.map((r) => r.item.id)));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      for (const e of active) await contentCancel(e.itemId);
    } catch (e) {
      onError(String(e));
    }
  };

  const remove = async () => {
    setConfirmingRemove(false);
    setBusy(true);
    onError("");
    try {
      for (const row of covered) {
        if (row.status.state === "installed" || row.status.state === "corrupt") {
          await contentRemove(row.item.id);
        }
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
      await refresh();
      await onChanged();
    }
  };

  const labelOf = (id: string): string => {
    const row = covered.find((r) => r.item.id === id);
    return row ? t(`settings.${row.item.labelKey}`) : id;
  };
  const mb = (n: number): string => (n / 1048576).toFixed(1);
  const sizeOf = (e: ContentQueueEntry): string => {
    if (e.totalBytes <= 0) return "";
    return e.state === "queued"
      ? ` · ${mb(e.totalBytes)} MB`
      : ` · ${mb(e.receivedBytes)} / ${mb(e.totalBytes)} MB`;
  };
  const percent = (e: ContentQueueEntry): number =>
    e.totalBytes > 0 ? Math.round((e.receivedBytes / e.totalBytes) * 100) : 0;

  return (
    <div className="settings-managed-content">
      {active.length > 0 ? (
        <div className="settings-data-migrate" aria-live="polite">
          <div className="settings-key-input-row">
            <Button size="sm" onClick={() => void cancel()}>
              {t("settings.content_cancel")}
            </Button>
          </div>
          {active.map((e) => (
            <div key={e.itemId}>
              <p className="settings-toggle-hint">
                {labelOf(e.itemId)} — {t(`settings.content_state_${e.state}`)}
                {sizeOf(e)}
              </p>
              {(e.state === "downloading" || e.state === "resuming") && (
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label={labelOf(e.itemId)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent(e)}
                >
                  <div
                    className="progress-fill"
                    style={{ width: `${percent(e)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : allInstalled ? (
        <div className="settings-key-input-row">
          <span className="settings-toggle-hint">
            {t("settings.content_managed")}
          </span>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void contentOpenFolder().catch((e) => onError(String(e)))}
          >
            {t("settings.content_open_folder")}
          </Button>
          {confirmingRemove ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void remove()}>
                {t("settings.content_remove_confirm")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingRemove(false)}
              >
                {t("settings.content_cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
            >
              {t("settings.content_remove")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="settings-key-input-row">
            <Button size="sm" disabled={busy} onClick={() => void download()}>
              {failed
                ? t("settings.content_retry")
                : hasCorrupt
                  ? t("settings.content_redownload")
                  : t("settings.content_download_pair")}
            </Button>
            {failed && (
              <span className="settings-test-err">
                ✗ {labelOf(failed.itemId)}: {failed.error}
              </span>
            )}
          </div>
          {prereqKeys.map((k) => (
            <p key={k} className="settings-toggle-hint">
              {t(`settings.${k}`)}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
