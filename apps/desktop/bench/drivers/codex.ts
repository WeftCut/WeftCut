// apps/desktop/bench/drivers/codex.ts
//
// Placeholder for a second client. It exists so the Driver interface is
// compiled against something that is not Claude Code: a field only Claude could
// fill would show up here as one this driver cannot.

import type { Driver, DriverRunInput, DriverRunOutput } from './types'

export const codexDriver: Driver = {
  name: 'codex',
  async run(input: DriverRunInput): Promise<DriverRunOutput> {
    // A real adapter writes `input.mcp` into Codex's MCP config, places
    // `input.skill_path` where Codex reads skills, runs `codex exec` in
    // `input.workdir` with `input.model`, and saves its JSON event stream to
    // `input.artifacts_dir`.
    void input
    throw new Error('codex driver: not implemented')
  },
}
