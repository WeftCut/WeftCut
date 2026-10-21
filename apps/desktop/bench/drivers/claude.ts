// apps/desktop/bench/drivers/claude.ts
//
// Headless Claude Code (`claude -p`) as a bench client. Each run gets a fresh
// working directory holding only the skill under test, an MCP config naming
// only the app, and a permission set of the weftcut tools plus file tools
// inside that directory. The aim is that the machine's own Claude Code setup —
// user settings, plugins, skills, MCP servers, memory — changes nothing about
// the run; README.md lists what the CLI does not let us shut out.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Driver, DriverRunInput, DriverRunOutput } from './types'

/** The server name in the MCP config, which fixes the tool prefix the agent
 *  sees (`mcp__weftcut__*`) — the same name a user's own install uses, so the
 *  skill's tool references read as they do in the field. */
const SERVER = 'weftcut'

/** Built-in tools the agent gets. File tools for Motif authoring on disk;
 *  Skill to load the skill; ToolSearch because Claude Code defers MCP tool
 *  schemas once a server exposes many; the two MCP resource tools because the
 *  skill reads `project://` resources. No Bash, web or subagent tools. */
const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']

/** What runs without asking, under `dontAsk` (everything else is refused, never
 *  prompted). Path rules are relative to the working directory, so file tools
 *  stop at its edge; `Skill(weftcut)` keeps the CLI's bundled skills, which no
 *  flag removes from the listing, from being invoked. */
const ALLOWED = [
  `mcp__${SERVER}`,
  `Skill(${SERVER})`,
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  // Read rules also govern Glob and Grep, Edit rules also govern Write.
  'Read(./**)',
  'Edit(./**)',
]

/** Settings applied on top of the project source (the only one loaded): no
 *  auto-memory, so a run neither reads nor leaves notes for the next. */
const SETTINGS = { autoMemoryEnabled: false }

/** Variables a parent Claude Code session exports to its children. Inherited,
 *  they make the bench's `claude` believe it is a nested session of whatever
 *  launched the bench. Auth and provider selection (`*_API_KEY`,
 *  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`) pass through. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'AI_AGENT') continue
    if (k.startsWith('CLAUDE_CODE_') && !/OAUTH|API_KEY|USE_|BEDROCK|VERTEX|FOUNDRY|SKIP_.*AUTH/.test(k)) continue
    env[k] = v
  }
  return env
}

/** The skill as Claude Code finds a project skill. Copied, not linked: a link
 *  would let the agent's Edit tool write through into the repo's skill. */
function installSkill(skillPath: string, workdir: string): void {
  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) throw new Error(`no SKILL.md in ${skillPath}`)
  fs.cpSync(skillPath, path.join(workdir, '.claude', 'skills', SERVER), { recursive: true })
}

interface ResultEvent {
  type: 'result'
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  num_turns?: number
  subtype?: string
  terminal_reason?: string
}

export const claudeDriver: Driver = {
  name: 'claude',
  async run(input: DriverRunInput): Promise<DriverRunOutput> {
    installSkill(input.skill_path, input.workdir)
    const transcriptPath = path.join(input.artifacts_dir, 'transcript.jsonl')
    const stderrPath = path.join(input.artifacts_dir, 'driver-stderr.log')
    const mcpConfig = {
      mcpServers: {
        [SERVER]: { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.bearer_token}` } },
      },
    }
    const args = [
      '-p',
      // Stream-json both ways keeps one session open across the stand-in
      // user's replies, with nothing persisted to resume from.
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', input.model,
      // `project` is the workdir, which holds the skill and nothing else; user
      // and local settings (plugins, hooks, permissions, user skills) stay out.
      '--setting-sources', 'project',
      '--settings', JSON.stringify(SETTINGS),
      '--strict-mcp-config', `--mcp-config=${JSON.stringify(mcpConfig)}`,
      '--tools', TOOLS.join(','),
      '--permission-mode', 'dontAsk',
      '--allowedTools', ALLOWED.join(','),
      '--no-session-persistence',
      ...(input.limits.budget_usd !== undefined ? ['--max-budget-usd', String(input.limits.budget_usd)] : []),
    ]
    // The prompt goes on stdin: `--allowedTools` and `--mcp-config` are
    // variadic, and a trailing positional prompt would be read as one more
    // tool name.
    const child = spawn('claude', args, { cwd: input.workdir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    const transcript = fs.createWriteStream(transcriptPath)
    const stderr = fs.createWriteStream(stderrPath)
    const say = (text: string) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
    say(input.task.prompt)
    child.stderr.pipe(stderr)
    const replies: string[] = []
    let turn = 0
    // After each finished turn, the runner decides whether the user answers.
    const afterTurn = async (event: ResultEvent) => {
      turn++
      const reply = !event.is_error && input.next_user_turn ? await input.next_user_turn(turn, event.result).catch(() => null) : null
      if (reply) { replies.push(reply); say(reply) } else child.stdin.end()
    }

    let result: ResultEvent | undefined
    // Each user turn ends in its own result event: total_cost_usd is the
    // session's so far, num_turns only that turn's.
    let turns = 0
    let pending = ''
    child.stdout.on('data', (chunk: Buffer) => {
      transcript.write(chunk)
      pending += chunk.toString('utf8')
      let nl: number
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (!line.includes('"type":"result"')) continue
        try {
          const event = JSON.parse(line) as ResultEvent
          if (event.type === 'result') { result = event; turns += event.num_turns ?? 0; void afterTurn(event) }
        } catch {
          // A partial or foreign line; the transcript keeps it regardless.
        }
      }
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, input.limits.timeout_ms)
    const { code, signal, spawnError } = await new Promise<{ code: number | null; signal: string | null; spawnError?: Error }>((resolve) => {
      child.once('error', (e) => resolve({ code: null, signal: null, spawnError: e }))
      child.once('close', (c, s) => resolve({ code: c, signal: s }))
    })
    clearTimeout(timer)
    await Promise.all([transcript, stderr].map((s) => new Promise((r) => s.end(r))))

    const final = result as ResultEvent | undefined
    const error = spawnError ? spawnError.message
      : timedOut ? `timed out after ${input.limits.timeout_ms} ms`
      : !final ? `claude exited ${code ?? signal} without a result event; see driver-stderr.log`
      : final.is_error ? `claude reported an error (${final.terminal_reason ?? final.subtype}): ${final.result ?? ''}`
      : undefined
    return {
      transcript_path: transcriptPath,
      final_message: final?.result,
      cost_usd: final?.total_cost_usd,
      turns: final ? turns : undefined,
      ...(replies.length ? { user_replies: replies } : {}),
      exit: { ok: !error && code === 0, code, signal, timed_out: timedOut, ...(error ? { error } : {}) },
    }
  },
}
