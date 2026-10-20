// apps/desktop/bench/drivers/types.ts
//
// The seam between the bench and an agent client (ADR 0123, spec Q29a). A
// driver runs one agent session against an already-prepared project and
// reports where its transcript went; everything the bench MEASURES — snapshots,
// the review diff, the checklist — is taken by the runner over its own MCP
// client, never from the driver. So a second client is a new file here, not a
// change to the runner, and nothing below may name a Claude-only concept.

import type { BenchTask } from '../tasks'

/** Where the agent reaches WeftCut: the app's streamable-HTTP MCP endpoint and
 *  the bearer token it was launched with. A driver adapts this to its client's
 *  own MCP configuration. */
export interface McpEndpoint {
  url: string
  bearer_token: string
}

export interface DriverRunInput {
  task: BenchTask
  /** A directory holding `SKILL.md` (and its sibling files), loaded the way the
   *  client loads a user-installed skill. */
  skill_path: string
  mcp: McpEndpoint
  /** Passed through to the client verbatim. */
  model: string
  /** Fresh, empty, and the agent's working directory: the only place its file
   *  tools may write (a Motif authored on disk lands here). */
  workdir: string
  /** The run's result directory. The driver writes its transcript (and any
   *  client-native logs) here; the agent never sees it. */
  artifacts_dir: string
  limits: {
    /** Wall clock for the whole session; the driver kills the client past it. */
    timeout_ms: number
    /** Spend ceiling, for a client that can enforce one. Others ignore it and
     *  the runner records what was spent. */
    budget_usd?: number
  }
}

export interface DriverExit {
  /** The client's own success judgement — it finished its turn without an
   *  error. Says nothing about the quality of the edit. */
  ok: boolean
  code: number | null
  signal: string | null
  timed_out: boolean
  error?: string
}

export interface DriverRunOutput {
  /** Absolute path of the transcript, in whatever line format the client
   *  emits; the runner copies it as-is. */
  transcript_path: string
  /** The agent's last message to the user — its own report, kept beside the
   *  review diff so the two can be compared. */
  final_message?: string
  cost_usd?: number
  /** Model round trips, as the client counts them. */
  turns?: number
  exit: DriverExit
}

export interface Driver {
  readonly name: string
  run(input: DriverRunInput): Promise<DriverRunOutput>
}

/** One run's record, written as `run.json`. File-valued fields name a file in
 *  the same directory (null when the run died before producing it), so the
 *  record stays small and diffable. `audit`, `frames` and `rounds` are fixed at
 *  null until H1/H3 give the app something to report. */
export interface RunResult {
  run_id: string
  task_id: string
  model: string
  driver: string
  /** Absolute skill directory and a content hash of it — the same name can
   *  hold different text across runs being compared. */
  skill: { path: string; sha256: string } | null
  /** `git describe` of the checkout the app was built from, best effort. */
  app_revision: string | null
  transcript: string | null
  baseline_project: string | null
  final_project: string | null
  review_diff: string | null
  /** Count of review-diff changes, for scanning a results root without
   *  opening each diff. */
  review_diff_size: number | null
  checklist: unknown
  audit: null
  frames: null
  cost: { usd: number | null; turns: number | null }
  rounds: null
  /** Motif drafts/installs the agent left behind (catalog diff), and the
   *  folder its working directory was copied to. */
  motifs: { added: unknown[]; changed: unknown[] } | null
  workdir_copy: string | null
  final_message: string | null
  exit: DriverExit | null
  error: string | null
  started_at: string
  duration_ms: number
}
