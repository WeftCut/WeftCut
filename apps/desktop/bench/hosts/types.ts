// apps/desktop/bench/hosts/types.ts
//
// Where the app under test runs. `local` launches the built app on this
// machine through the e2e launcher (Playwright page and all); `remote` runs it
// on another machine over SSH and reaches it only through MCP. The runner talks
// to a HostSession and never asks which kind it has, except where a capability
// is genuinely missing remotely (no renderer: no job events, no IPC).

import type { McpEndpoint } from '../drivers/types'
import type { JobEvent } from '../mediaReady'

/** fixtures.mjs `fixture.json`, as far as the runner reads it. */
export interface FixtureMeta {
  id: string
  output: { sha256: string; bytes: number; duration_s: number }
  transcode: Record<string, unknown> & { ffmpeg_version: string }
  [k: string]: unknown
}

export interface HostStartOptions {
  /** Short, path-safe id of this run; names the remote run directory. */
  run_slug: string
  out_dir: string
  /** The agent's local working directory (mirrored to the app host when it
   *  is remote). */
  workdir: string
  app_memory_mib?: number
}

export interface TemplateMeta {
  key: string
  parts: Record<string, unknown>
  /** Where the project lived when the template was built, in the host's
   *  spelling: the baseline's paths are relative to it. */
  project_dir: string
  created_at: string
  media_wait_ms: number | null
}

export interface TemplateStore {
  /** The template, its fresh build's baseline and the task ids that used it. */
  get(key: string): Promise<{ meta: TemplateMeta; baseline: unknown; tasks: string[] } | null>
  /** Copy a settled project folder (minus Backups/ and Logs/) into the store,
   *  labelled with the task that built it. */
  save(key: string, projectDir: string, meta: TemplateMeta, baseline: unknown, taskId: string): Promise<{ ms: number; bytes: number }>
  /** Add a task id to the template's label; returns every id so far. */
  label(key: string, taskId: string): Promise<string[]>
  /** Copy a template's project folder to `destDir`, which must not exist. */
  restore(key: string, destDir: string): Promise<{ ms: number; bytes: number }>
}

export interface HostSession {
  readonly kind: 'local' | 'remote'
  /** Identity and launch facts for run.json `host`; teardown facts are added
   *  by close(). */
  readonly record: Record<string, unknown>
  /** The app build under test, for run.json and template keys. */
  readonly app: { revision: string | null; build: string }
  /** Templates are per host: part of their key. */
  readonly hostId: string
  /** Where the runner's own MCP client connects. */
  readonly runnerTransport: { url: string; bearer_token: string; fetch?: typeof fetch }
  /** What the agent client is given (remote: the path-mapping proxy). */
  readonly agentEndpoint: McpEndpoint
  /** Parent folder for the run's projects, in the host's path spelling. */
  readonly projectsDir: string
  joinPath(...parts: string[]): string
  /** Each fixture's MP4 on the host and its fetch-time record
   *  (fixtures.mjs `fixture.json`: transcode parameters, ffmpeg version,
   *  output sha256). */
  resolveFixtures(ids: readonly string[]): Promise<{ paths: Map<string, string>; meta: Record<string, FixtureMeta> }>
  appResources(): Promise<{ policy: unknown; allocation: unknown } | null>
  /** The inference/speech models the app's profile carries (remote seeds them
   *  from the user's profile); null when the host does not seed any. */
  readonly models: unknown
  /** `media:job_*` events from the renderer; null where there is none. */
  readonly jobEvents: { start(): Promise<void>; read(): Promise<JobEvent[]> } | null
  /** What to save when the media wait times out. */
  timeoutDiagnostics(): Promise<unknown>
  /** Where the app runs and what GPU it got, as far as the host can tell. */
  status(): Promise<unknown>
  readonly templates: TemplateStore
  /** Tear the app down, keep its logs in out_dir, record what was left. */
  close(): Promise<void>
}
