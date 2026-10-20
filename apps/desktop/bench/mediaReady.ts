// apps/desktop/bench/mediaReady.ts
//
// Hold the baseline until imported media has finished its background work.
// An import returns at once and fans out derivative jobs (native/src/jobs:
// thumbnails, audio conform, waveform, the proxy decision and the quick/full
// proxies). Handed over mid-flight, an agent meets "waveform not ready" from
// `detect_pauses` or a half-proxied preview, and the bench would be measuring
// how long the machine took to transcode, not what the model did.
//
// Two sources, because neither is enough alone. The project's media pool is
// the authority on what has LANDED (`waveform_path`, `decode_route.full_proxy`
// …). But a job that fails never lands, and a job that finishes without an
// artifact (a quick proxy the GOP probe made unnecessary) leaves its field
// null; only the `media:job_*` events the app sends its renderer say so.
//
// The events are not balanced enough to count on their own: the timeline
// re-requests a waveform dozens of times, the requests join one job, and a run
// has been seen to end one `started` short of its `complete`s with the
// waveform long landed. So an open job holds the wait only for a kind that
// has not landed — which still covers a kind this file does not enumerate.

import type { Page } from '@playwright/test'

/** The wire shape of a pool item, as far as readiness reads it
 *  (`MediaItem` in src/main/state/model.ts, `DecodeRoute` in
 *  src/shared/decode-route.ts). */
interface MediaWire {
  id: string
  label: string | null
  kind: 'Video' | 'Audio' | 'Image' | 'Subtitle'
  file_hash_blake3: string
  metadata: { audio?: unknown }
  decode_route: { route: string; quick_proxy?: string | null; full_proxy?: string | null }
  conform_path: string | null
  waveform_path: string | null
  thumbnails_dir: string | null
}

interface JobEvent {
  event: 'media:job_started' | 'media:job_complete' | 'media:job_error'
  media_id: string
  /** `JobKind`, serde-lowercased: thumbnails, proxy, quick_proxy,
   *  proxy_bypass, waveform, conform, audio_fx. */
  kind: string
  error?: string
}

/** How one awaited derivative ended. `landed`: its field is set in the
 *  project. `complete`: the job reported done without setting it. */
type Outcome = 'landed' | 'complete' | 'failed'

export interface MediaWait {
  waited_ms: number
  items: Array<{ media_id: string; label: string | null; kind: string; route: string; derivatives: Record<string, Outcome> }>
  job_errors: Array<{ media_id: string; kind: string; error: string }>
  /** `media:kind` jobs reported started and not ended at hand-over, all of a
   *  kind whose artifact had already landed. */
  open_jobs: string[]
}

declare global {
  interface Window { __benchMediaJobs?: JobEvent[] }
}

/** Start recording job events. Call before the first import: a job that
 *  starts and fails before the listener exists would leave a field null
 *  forever and read as still pending. */
export async function recordMediaJobs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: JobEvent[] = (window.__benchMediaJobs = [])
    const api = (window as unknown as { api: { on(e: string, cb: (p: unknown) => void): () => void } }).api
    for (const event of ['media:job_started', 'media:job_complete', 'media:job_error'] as const)
      api.on(event, (p) => {
        const { media_id, kind, error } = p as { media_id: string; kind: string; error?: string }
        log.push({ event, media_id, kind, ...(error !== undefined ? { error } : {}) })
      })
  })
}

/** The derivatives this item will get, each with whether its field has
 *  landed — the same fan-out as `enqueue_for_media` / `spawn_proxy_decision`.
 *  The proxy pair follows the route as it stands: before the decision a video
 *  reads as `proxied` with nothing landed, so it cannot pass early; once the
 *  decision commits `direct-export`, only the quick proxy is still owed. */
function expected(m: MediaWire): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [['hash', !m.file_hash_blake3.startsWith('pending-')]]
  if (m.kind === 'Video') out.push(['thumbnails', m.thumbnails_dir !== null])
  if (m.metadata.audio) out.push(['conform', m.conform_path !== null], ['waveform', m.waveform_path !== null])
  if (m.kind === 'Video') {
    const r = m.decode_route
    if (r.route !== 'bypass') out.push(['quick_proxy', !!r.quick_proxy])
    if (r.route === 'proxied' || r.route === 'native-sw') out.push(['proxy', !!r.full_proxy])
  }
  return out
}

/** Poll until every pool item's derivatives have landed, completed or failed
 *  and no started job is still open; past `timeoutMs`, throw naming what is
 *  still pending. A failed job does not fail the run — it is part of the
 *  environment the agent gets — but it is recorded. */
export async function waitForMedia(
  page: Page,
  readPool: () => Promise<Record<string, MediaWire>>,
  timeoutMs: number,
): Promise<MediaWait> {
  const start = Date.now()
  for (;;) {
    const pool = Object.values(await readPool())
    const events = await page.evaluate(() => window.__benchMediaJobs ?? [])
    const ended = (id: string, kind: string, event: JobEvent['event']) =>
      events.some((e) => e.media_id === id && e.kind === kind && e.event === event)
    const open = new Map<string, number>()
    for (const e of events) {
      const key = `${e.media_id}:${e.kind}`
      open.set(key, (open.get(key) ?? 0) + (e.event === 'media:job_started' ? 1 : -1))
    }
    const pending: string[] = []
    const settled = new Set<string>()
    const items: MediaWait['items'] = pool.map((m) => {
      const derivatives: Record<string, Outcome> = {}
      for (const [kind, landed] of expected(m)) {
        if (landed) derivatives[kind] = 'landed'
        else if (ended(m.id, kind, 'media:job_error')) derivatives[kind] = 'failed'
        else if (ended(m.id, kind, 'media:job_complete')) derivatives[kind] = 'complete'
        else pending.push(`${m.label ?? m.id}:${kind}`)
        if (derivatives[kind]) settled.add(`${m.id}:${kind}`)
      }
      return { media_id: m.id, label: m.label, kind: m.kind, route: m.decode_route.route, derivatives }
    })
    const running = [...open].filter(([, n]) => n > 0).map(([key]) => key)
    pending.push(...running.filter((key) => !settled.has(key)).map((key) => `${key} (job running)`))
    if (!pending.length) {
      const job_errors = events.filter((e) => e.event === 'media:job_error')
        .map((e) => ({ media_id: e.media_id, kind: e.kind, error: e.error ?? '' }))
      return { waited_ms: Date.now() - start, items, job_errors, open_jobs: running }
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(`media still processing after ${Math.round(timeoutMs / 1000)} s: ${pending.join(', ')}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** The raw event log, for `media-jobs.json`. */
export function mediaJobLog(page: Page): Promise<unknown[]> {
  return page.evaluate(() => window.__benchMediaJobs ?? [])
}
