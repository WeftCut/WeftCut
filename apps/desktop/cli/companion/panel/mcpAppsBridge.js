// The view's half of MCP Apps (extension `io.modelcontextprotocol/ui`, spec
// 2026-01-26): JSON-RPC over postMessage with the host that frames the view.
// Only the messages the side panel uses, written out: the handshake, the tool
// calls the host forwards to this server, size reports, and the host's
// teardown. Every other request from the host is answered "method not found".

export const PROTOCOL_VERSION = '2026-01-26'

/** How long a request to the host may go unanswered. A tool call the app holds
 *  (`side_preview_sync { op: "events" }`) answers within about a second; one
 *  that outlives this is lost, and the view asks again. */
export const REQUEST_TIMEOUT_MS = 15_000

const METHOD_NOT_FOUND = -32601

/**
 * @param {{
 *   post(message: object): void,
 *   subscribe(listener: (message: unknown) => void): () => void,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} deps `post` sends to the host (the frame's parent), `subscribe` hears
 *   what the host sends; the caller checks that a message came from the parent.
 */
export function mcpAppsBridge({ post, subscribe, timers = globalThis }) {
  let nextId = 1
  /** Requests of the view's awaiting the host: id → settle. */
  const pending = new Map()
  const notificationHandlers = new Map()
  const requestHandlers = new Map()

  const unsubscribe = subscribe((message) => {
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') return
    const hasId = message.id !== undefined && message.id !== null
    if (typeof message.method === 'string') {
      if (hasId) void answerHost(message)
      else notificationHandlers.get(message.method)?.(message.params ?? {})
      return
    }
    if (!hasId) return
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) settle.reject(Object.assign(new Error(String(message.error?.message ?? 'error')), { code: message.error?.code }))
    else settle.resolve(message.result)
  })

  async function answerHost({ id, method, params }) {
    const handler = requestHandlers.get(method)
    if (handler === undefined) {
      post({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `${method} is not handled by this view` } })
      return
    }
    try {
      post({ jsonrpc: '2.0', id, result: (await handler(params ?? {})) ?? {} })
    } catch (error) {
      post({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } })
    }
  }

  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error(`${method} got no answer`), { code: 'timeout' }))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => { timers.clearTimeout(timer); resolve(value) },
        reject: (error) => { timers.clearTimeout(timer); reject(error) },
      })
      post({ jsonrpc: '2.0', id, method, params })
    })
  }

  function notify(method, params) {
    post({ jsonrpc: '2.0', method, params })
  }

  return {
    /** The handshake: the host's answer carries its context (`locale`,
     *  `theme`, `displayMode`). */
    async initialize(appInfo) {
      const result = await request('ui/initialize', { appInfo, appCapabilities: {}, protocolVersion: PROTOCOL_VERSION })
      notify('ui/notifications/initialized', {})
      return result ?? {}
    },
    /** A tool of this server, called through the host. Rejects when the host
     *  answers with an error or not at all; a tool's own failure is a result
     *  with `isError`. */
    callTool(name, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      return request('tools/call', { name, arguments: args }, timeoutMs)
    },
    sizeChanged(width, height) {
      notify('ui/notifications/size-changed', { width, height })
    },
    /** A host notification, such as `ui/notifications/host-context-changed`. */
    onNotification(method, handler) { notificationHandlers.set(method, handler) },
    /** A host request, such as `ui/resource-teardown`; `handler`'s value is
     *  the result. */
    onRequest(method, handler) { requestHandlers.set(method, handler) },
    close() {
      unsubscribe()
      for (const settle of pending.values()) settle.reject(Object.assign(new Error('the view closed'), { code: 'closed' }))
      pending.clear()
    },
  }
}
