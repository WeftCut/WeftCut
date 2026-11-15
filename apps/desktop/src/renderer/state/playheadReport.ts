// The editor's answer to `project://playhead` (`main/mcp/playheadView.ts`):
// where the user is, read from the stores at the moment main asks. Nothing is
// subscribed and nothing is sent between asks.

import { listen } from "../bridge/events";
import { invokeRaw } from "../bridge/ipc";
import { formatTimecode } from "../frames";
import { localClockUs } from "../render/timeProjection";
import {
  PLAYHEAD_READ_EVENT,
  PLAYHEAD_REPORT,
  type EditorPlayheadReport,
  type PlayheadReadMessage,
  type PlayheadReportMessage,
} from "../../shared/editorPlayhead";
import { usePlaybackStore } from "./playbackStore";
import { anchorFrameOf, playheadClockUsIn } from "./playheadProjection";
import { currentOpenComposition, useProjectStore } from "./projectStore";
import { rangeInUs, rangeOutUs, resolveMarkedRange } from "./rangeStore";
import { currentSelection, layerIdsOf } from "./selectionStore";

const NOT_LOADED = "The editor has not loaded the project yet; retry in a moment.";

/// The view on the focused timeline's clock, the one an edit "at the playhead"
/// uses (`playheadClockUs`), so the time and the layer spans an agent reads
/// for that composition agree. Null before the editor holds a project.
///
/// The range is stored in ROOT time and resolved against the film's length
/// before it is projected; a composition no placement reaches (an orphan) has
/// no reading of it and reports none.
export function playheadReport(): EditorPlayheadReport | null {
  const summary = useProjectStore.getState().summary;
  const composition = currentOpenComposition();
  if (summary === null || composition === null) return null;
  const frame = anchorFrameOf(composition.id);
  const tUs = playheadClockUsIn(composition.id, frame);
  const root = summary.compositions[summary.root_id];
  const marked = root ? resolveMarkedRange(rangeInUs(), rangeOutUs(), root.duration_us) : null;
  return {
    root_id: summary.root_id,
    composition_id: composition.id,
    t_us: tUs,
    timecode: formatTimecode(tUs, composition.fps_num, composition.fps_den),
    playing: usePlaybackStore.getState().playing,
    range: marked === null || frame === null
      ? null
      : { t_start_us: localClockUs(frame, marked.startUs), t_end_us: localClockUs(frame, marked.endUs) },
    selection: [...layerIdsOf(currentSelection())],
  };
}

/// Answer main's reads for as long as the editor is mounted. Returns the stop.
export function installPlayheadReport(): () => void {
  const unlisten = listen<PlayheadReadMessage>(PLAYHEAD_READ_EVENT, ({ payload }) => {
    const report = playheadReport();
    const message: PlayheadReportMessage = report === null
      ? { request_id: payload.request_id, error: NOT_LOADED }
      : { request_id: payload.request_id, report };
    // A read is no edit: it skips the publication barrier `invoke` waits on.
    void invokeRaw(PLAYHEAD_REPORT, message).catch(() => {});
  });
  return () => void unlisten.then((f) => f());
}
