/** Native completion callbacks can already be queued in the JS event loop when
 * a workspace is replaced. The generation check is therefore repeated here,
 * after native cancellation, before anything reaches the actor or renderer. */
export function createWorkspaceEventGate() {
  let generation: number | null = 0
  return {
    beginTransition() { generation = null },
    activate(next: number) { generation = next },
    current() { return generation },
    requireCurrent() {
      if (generation === null) throw new Error('Project is changing; retry after it opens')
      return generation
    },
    accept(payload: unknown) {
      if (!payload || typeof payload !== 'object' || !('workspace_generation' in payload)) return true
      return generation !== null && payload.workspace_generation === generation
    },
  }
}
