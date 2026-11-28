// The Host half: `/weftcut`, which opens the side preview with no model turn,
// starting WeftCut first when it is closed. It calls the server's own tools,
// so what "closed", "start" and "link" mean stays the binary's and the app's.
// The server is this bundle's `weftcut-mcp` row (cordis.patch.yml, written by
// WeftCut). The card in the sidebar runs the same command (client.js).

export const name = 'weftcut-dsh'
export const inject = ['commands', 'tools']

const SERVER = 'weftcut'
const OPEN = `mcp__${SERVER}__open_side_preview`
const LAUNCH = `mcp__${SERVER}__launch_weftcut`
// After a launch the binary announces the app's tools (tools/list_changed) and
// the Harness lists them again. A liveness bound, not an expected time.
const TOOLS_DEADLINE_MS = 30_000
const RETRY_MS = 250

export function apply(ctx) {
  ctx.commands.register({
    name: 'weftcut',
    description: 'Open the WeftCut side preview, starting WeftCut if it is closed',
    handler: async ({ agent, signal }) => {
      let seq = 0
      const call = async (tool) => {
        const id = `weftcut-command-${Date.now().toString(36)}-${seq++}`
        const out = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name: tool, arguments: '{}' }], signal, agent })
        return out.results[0].result
      }
      const unknown = (result) => result.isError && result.error?.info?.code === 'UNKNOWN_TOOL'

      let result = await call(OPEN)
      if (result.isError) {
        // The app is closed, or quitting: only the binary's own tools are
        // listed, or the binary still lists the app's and answers that the app
        // is not running. `launch_weftcut` is safe on a running app.
        const launched = await call(LAUNCH)
        if (unknown(launched)) {
          return { kind: 'error', text: 'The weftcut server is not connected. Open WeftCut once, then reload this page.' }
        }
        if (launched.isError) return { kind: 'error', text: textOf(launched) }
        const deadline = Date.now() + TOOLS_DEADLINE_MS
        result = await call(OPEN)
        while (result.isError && Date.now() < deadline) {
          await sleep(RETRY_MS, signal)
          result = await call(OPEN)
        }
        if (unknown(result)) return { kind: 'error', text: 'WeftCut started, but its tools did not arrive in time. Run /weftcut again.' }
      }
      if (result.isError) return { kind: 'error', text: textOf(result) }
      const url = urlOf(result)
      if (url === undefined) return { kind: 'error', text: 'WeftCut answered without a side preview link.' }
      // client.js reads the link back out of this line.
      return { kind: 'success', text: `WeftCut side preview: ${url}` }
    },
  })
}

function urlOf(result) {
  const url = result.value?.structuredContent?.url
  if (typeof url === 'string') return url
  for (const part of result.content ?? []) {
    if (part.type !== 'text') continue
    try {
      const parsed = JSON.parse(part.text).url
      if (typeof parsed === 'string') return parsed
    } catch {}
  }
  return undefined
}

function textOf(result) {
  const text = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  return text !== '' ? text : 'WeftCut could not open the side preview.'
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
