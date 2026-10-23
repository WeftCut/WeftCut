// apps/desktop/bench/drivers/codex.ts
//
// Placeholder for a second client. It exists so the Driver interface is
// compiled against something that is not Claude Code: a field only Claude could
// fill would show up here as one this driver cannot.
//
// Until it is real it is a null agent: it touches nothing and reports a failed
// session, so a run with it still produces the full evidence (launch, setup,
// media wait, baseline, an empty review diff) for free — the bench's plumbing
// check, local or remote.

import fs from 'node:fs'
import path from 'node:path'
import type { Driver, DriverRunInput, DriverRunOutput } from './types'

export const codexDriver: Driver = {
  name: 'codex',
  async run(input: DriverRunInput): Promise<DriverRunOutput> {
    // A real adapter writes `input.mcp` into Codex's MCP config, places
    // `input.skill_path` where Codex reads skills, runs `codex exec` in
    // `input.workdir` with `input.model`, and saves its JSON event stream to
    // `input.artifacts_dir`.
    const transcript = path.join(input.artifacts_dir, 'transcript.jsonl')
    fs.writeFileSync(transcript, '')
    return {
      transcript_path: transcript,
      exit: { ok: false, code: null, signal: null, timed_out: false, error: 'codex driver: not implemented (null agent: no session was run)' },
    }
  },
}
