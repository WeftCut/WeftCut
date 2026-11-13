import { listen } from '../../bridge/events';
import { invoke } from '../../bridge/ipc';
import { MOTIF_BAKE_READY_EVENT, type MotifBakeSession } from '../../../shared/motifs/baking';
import { bindMotifFrameWorkspace } from './motifFrameSource';

/** Main-window lifetime. The workspace is bound before Preview or export can
 * request frames, and Save As can replace it without remounting the editor. */
export async function installMotifFrameWorkspaceListener(): Promise<() => void> {
  let receivedReady = false;
  const unlisten = await listen<MotifBakeSession>(MOTIF_BAKE_READY_EVENT, ({ payload }) => {
    receivedReady = true;
    bindMotifFrameWorkspace(payload.generation);
  });
  // A renderer reload can miss the open event. If a switch is in progress,
  // discovery can fail and its ready event supplies the settled generation.
  const session = await invoke<MotifBakeSession>('motif_bake_session').catch(() => null);
  if (!receivedReady && session) bindMotifFrameWorkspace(session.generation);
  return unlisten;
}
