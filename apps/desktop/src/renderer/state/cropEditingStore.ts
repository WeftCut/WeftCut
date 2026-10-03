import { create } from 'zustand';
import type { CropRect } from '../../shared/crop';

// Session-only tool state. Drafts are consumed only by preview; IPC commits
// persist the rectangle and make it visible to export in one history entry.
export const useCropEditingStore = create<{
  layerId: string | null; draft: CropRect | null | undefined;
}>(() => ({ layerId: null, draft: undefined }));

export function beginCrop(layerId: string): void {
  useCropEditingStore.setState({ layerId, draft: undefined });
}
export function endCrop(): void {
  useCropEditingStore.setState({ layerId: null, draft: undefined });
}
export function cropPreview(layerId: string): CropRect | null | undefined {
  const s = useCropEditingStore.getState();
  return s.layerId === layerId ? s.draft : undefined;
}
