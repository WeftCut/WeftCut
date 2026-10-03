import { updateLayerParams, projectSummary } from '../ipc';
import { useOpenComposition, currentOpenComposition, useProjectStore } from '../state/projectStore';
import { currentSelection, primaryLayerIdOf, usePrimaryLayerId } from '../state/selectionStore';
import { previewRenderTargetId, usePreviewRenderTargetId } from '../state/compositionAnchorStore';
import { focusedPlayheadUs, seekLocalUs } from '../state/playheadProjection';
import { transportPause } from '../state/playbackStore';
import { beginCrop, endCrop, useCropEditingStore } from '../state/cropEditingStore';
import { setTool } from '../state/toolStore';
import { usePathEditingStore } from '../state/pathEditingStore';
import type { CompositionSummary } from '../ipc';

export const CROP_MENU_COMMAND_IDS = ['editCrop', 'resetCrop'] as const;

function targetIn(comp: CompositionSummary | null, id: string | null, previewId: string | null) {
  if (!comp || comp.id !== previewId || !id) return null;
  const track = comp.tracks.find(t => t.layers.some(l => l.id === id));
  const layer = track?.layers.find(l => l.id === id);
  return track?.enabled && !track.locked && layer?.enabled && !layer.locked && layer.params.kind === 'VideoClip'
    ? { layer, comp } : null;
}

function cropTarget() {
  return targetIn(currentOpenComposition(), primaryLayerIdOf(currentSelection()), previewRenderTargetId());
}

export function canEditCrop(): boolean { return cropTarget() !== null; }
export function canResetCrop(): boolean {
  const target = cropTarget();
  return !!target && target.layer.params.kind === 'VideoClip' && !!target.layer.params.crop;
}
export function useCanEditCrop(): boolean {
  return targetIn(useOpenComposition(), usePrimaryLayerId(), usePreviewRenderTargetId()) !== null;
}

export function editCrop(): void {
  const target = cropTarget();
  if (!target) return;
  if (useCropEditingStore.getState().layerId === target.layer.id) { endCrop(); return; }
  transportPause();
  const now = focusedPlayheadUs();
  if (now < target.layer.t_start_us || now >= target.layer.t_end_us)
    seekLocalUs(target.comp.id, target.layer.t_start_us);
  setTool('select');
  usePathEditingStore.setState({ layerId: null });
  beginCrop(target.layer.id);
}

export async function resetCrop(): Promise<void> {
  const target = cropTarget();
  if (!target || !canResetCrop()) return;
  endCrop();
  await updateLayerParams(target.layer.id, { kind: 'VideoClip', crop: null });
  useProjectStore.getState().apply(await projectSummary());
}
