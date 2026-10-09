import { invoke } from '../../bridge/ipc';
import { listen } from '../../bridge/events';
import { MOTIF_BAKE_READY_EVENT, type MotifBakePlan, type MotifBakeSession, type MotifBakeSnapshot } from '../../../shared/motifs/baking';

export interface MotifBakeClientDeps {
  session(): Promise<MotifBakeSession>;
  reconcile(plan: MotifBakePlan): Promise<MotifBakeSnapshot>;
  snapshot(): Promise<MotifBakeSnapshot>;
  listen(callback: (snapshot: MotifBakeSnapshot) => void): Promise<() => void>;
  listenReady(callback: (session: MotifBakeSession) => void): Promise<() => void>;
}
const bridge: MotifBakeClientDeps = {
  session: () => invoke('motif_bake_session'),
  reconcile: plan => invoke('motif_bake_reconcile', { plan }),
  snapshot: () => invoke('motif_bake_snapshot'),
  listen: callback => listen<MotifBakeSnapshot>('motif:bake', event => callback(event.payload)),
  listenReady: callback => listen<MotifBakeSession>(MOTIF_BAKE_READY_EVENT, event => callback(event.payload)),
};

/** Serialized latest-plan client. Disposal detaches the observer, never the
 * main-owned jobs. A subscription precedes discovery so progress cannot be lost. */
export class MotifBakeClient {
  private epoch = 0;
  private disposed = false;
  private running = false;
  private invalidated = false;
  private pending: { epoch: number; projectId: string | null; plan: (session: MotifBakeSession) => MotifBakePlan } | null = null;
  private latest: { projectId: string | null; plan: (session: MotifBakeSession) => MotifBakePlan } | null = null;
  private generation: number | null = null;
  private signature = '';
  private snapshot: MotifBakeSnapshot | null = null;
  private unsubscribe: Promise<() => void>;

  constructor(
    private readonly changed: (snapshot: MotifBakeSnapshot) => void,
    private readonly failed: (error: unknown) => void,
    private readonly deps: MotifBakeClientDeps = bridge,
  ) {
    this.unsubscribe = Promise.all([
      deps.listen(snapshot => {
        if (this.disposed || this.running || this.invalidated || snapshot.generation !== this.generation) return;
        this.snapshot = snapshot;
        this.changed(snapshot);
      }),
      deps.listenReady(session => this.sessionReady(session)),
    ]).then(unsubscribers => () => { for (const unsubscribe of unsubscribers) unsubscribe(); });
    // The drain reports subscription errors; avoid an unhandled rejection
    // before the first project arrives.
    void this.unsubscribe.catch(() => {});
  }

  reconcile(projectId: string | null, plan: (session: MotifBakeSession) => MotifBakePlan): void {
    if (this.disposed) return;
    this.latest = { projectId, plan };
    this.pending = { epoch: ++this.epoch, projectId, plan };
    if (!this.running) void this.drain();
  }

  private sessionReady(session: MotifBakeSession): void {
    if (this.disposed) return;
    const latest = this.latest;
    this.invalidate();
    this.latest = latest;
    // Same-generation recovery also reset main's jobs: a matching old
    // signature cannot stand in for a newly acknowledged declaration.
    this.signature = '';
    this.snapshot = null;
    // The actor may announce readiness before the renderer's new summary
    // arrives. Keep intent, but wait for reconcile with that project's ID.
    if (latest && latest.projectId === session.projectId) this.reconcile(latest.projectId, latest.plan);
  }

  /** Ignore observations while a newer project/catalog snapshot is resolving. */
  invalidate(): void {
    this.epoch++;
    this.pending = null;
    this.latest = null;
    this.invalidated = true;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      await this.unsubscribe;
      while (this.pending && !this.disposed) {
        const request = this.pending;
        this.pending = null;
        try {
          const session = await this.deps.session();
          if (request.epoch !== this.epoch || this.disposed) continue;
          if (session.projectId !== request.projectId) throw new Error('Project changed during Motif preparation');
          if (session.generation !== this.generation) {
            this.generation = session.generation;
            this.signature = '';
            this.snapshot = null;
          }
          const plan = request.plan(session);
          const signature = JSON.stringify(plan);
          const snapshot = !plan.retryKeys?.length && !plan.promoteKeys?.length && signature === this.signature && this.snapshot
            ? await this.deps.snapshot() : await this.deps.reconcile(plan);
          if (request.epoch !== this.epoch || this.disposed || snapshot.generation !== this.generation) continue;
          this.signature = signature;
          this.snapshot = snapshot;
          this.invalidated = false;
          this.changed(snapshot);
        } catch (error) {
          if (!this.disposed && request.epoch === this.epoch) this.failed(error);
        }
      }
    } catch (error) {
      if (!this.disposed) this.failed(error);
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.epoch++;
    this.pending = null;
    this.latest = null;
    void this.unsubscribe.then(off => off()).catch(() => {});
  }
}
