// Running derivative jobs (thumbnails, proxies, waveforms, conforms), fed by
// main's `media:job_*` events. App-wide rather than owned by the status bar:
// the bar unmounts in agent mode, and a job that started or ended meanwhile
// must still be counted, or dropped, when it comes back.

import { useEffect } from "react";
import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";
import { MEDIA_JOB_EVENTS, type MediaJobEvent } from "../ipc";

export interface DerivativeJob {
  media_id: string;
  kind: string;
  /// Renderer wall clock when the start arrived.
  since: number;
}

interface State {
  /// Keyed `media_id:kind`. A job is one kind on one media item: adopting a
  /// cached file emits completion without a start, and must not end another
  /// item's running job of the same kind.
  jobs: Readonly<Record<string, DerivativeJob>>;
}

export const useDerivativeJobsStore = create<State>(() => ({ jobs: {} }));

const keyOf = (job: MediaJobEvent): string => `${job.media_id}:${job.kind}`;

export function derivativeJobStarted(job: MediaJobEvent, now = Date.now()): void {
  const key = keyOf(job);
  useDerivativeJobsStore.setState((s) =>
    s.jobs[key] ? s : { jobs: { ...s.jobs, [key]: { media_id: job.media_id, kind: job.kind, since: now } } },
  );
}

export function derivativeJobEnded(job: MediaJobEvent): void {
  const key = keyOf(job);
  useDerivativeJobsStore.setState((s) => {
    if (!s.jobs[key]) return s;
    const { [key]: _ended, ...jobs } = s.jobs;
    return { jobs };
  });
}

/// Subscribes the store to main's job events for as long as the caller is
/// mounted. App mounts it once, in both editor and agent mode.
export function useDerivativeJobEvents(): void {
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    void Promise.all([
      listen<MediaJobEvent>(MEDIA_JOB_EVENTS.started, (e) => derivativeJobStarted(e.payload)),
      listen<MediaJobEvent>(MEDIA_JOB_EVENTS.complete, (e) => derivativeJobEnded(e.payload)),
      listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => derivativeJobEnded(e.payload)),
    ]).then((offs) => {
      if (cancelled) for (const off of offs) off();
      else unlisteners.push(...offs);
    });
    return () => {
      cancelled = true;
      for (const off of unlisteners) off();
    };
  }, []);
}

export function resetDerivativeJobsForTests(): void {
  useDerivativeJobsStore.setState({ jobs: {} });
}
