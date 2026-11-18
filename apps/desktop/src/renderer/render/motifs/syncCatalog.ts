// Fills the render catalog (`catalog.ts`) from the open project's Motif rows
// (`list_motifs { group: "project" }`): at boot (startup/initializeRenderer.ts),
// on every `motifs:changed`, and when the editor mounts on a project. The
// library is never in it.
import { listen } from "@/bridge/events";
import { listMotifCatalog, MOTIFS_CHANGED_EVENT } from "../../ipc";
import { setProjectMotifs, type MotifManifest } from "./catalog";

/// Answers that arrive out of order: only the latest request may land, or an
/// older project's rows could overwrite the open one's.
let generation = 0;

export async function syncProjectMotifsFromBackend(): Promise<void> {
  const mine = ++generation;
  try {
    const { project } = await listMotifCatalog("project");
    if (mine !== generation) return;
    const manifests: MotifManifest[] = [];
    const missing = [];
    for (const row of project) {
      if (row.motif) manifests.push(row.motif as MotifManifest);
      else if (row.status !== "ok") missing.push({ motif_id: row.id, status: row.status, diagnostic: row.diagnostic ?? "" });
    }
    setProjectMotifs(manifests, missing);
  } catch (e) {
    // Keep what the catalog holds: a transient IPC failure must not blank
    // every Motif layer.
    // eslint-disable-next-line no-console
    console.warn("[weftcut/motifs] syncProjectMotifsFromBackend failed; keeping the last catalog", e);
  }
}

/// Empties the catalog as the project goes; a pull still in flight lands nowhere.
export function clearProjectMotifs(): void {
  generation++;
  setProjectMotifs();
}

/// Re-pulls the catalog on every backend `motifs:changed`, so a Motif placed,
/// edited, updated or removed is resolvable by the frame math at once.
/// Returns the unlisten fn.
export async function installMotifsChangedListener(): Promise<() => void> {
  return listen(MOTIFS_CHANGED_EVENT, () => {
    void syncProjectMotifsFromBackend();
  });
}
