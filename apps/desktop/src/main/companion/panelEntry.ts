// apps/desktop/src/main/companion/panelEntry.ts
//
// The side-panel view as this app's MCP server serves it to a session that
// connected directly: its entry tool, its HTML resource, the view's own sync
// tool, and which client is listed them. The definitions are
// `cli/companion/panel/entry.json`, which the `weftcut` binary embeds too
// (`cli/panel.go`); through the binary a session sees the binary's entry and
// HTML and this app's sync tool. See docs/adr/0186.
import { createHash } from 'node:crypto'
import entryJson from '../../../cli/companion/panel/entry.json?raw'
import panelHtml from '../../../cli/companion/panel/panel.html?raw'

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } & Record<string, unknown>
}

interface Entry {
  extension: string
  mimeType: string
  uri: string
  resource: { name: string; description: string }
  tool: ToolDefinition
  result: string
  sync: ToolDefinition
}

const entry = JSON.parse(entryJson) as Entry

/** The view's address: `{hash}` is the first 12 hex digits of the SHA-256 of
 *  its HTML, since a host keeps a view by its address.
 *  LANDMINE: `cli/panel.go` `panelURI` computes the same; the parity test in
 *  `src/cli/integration.test.ts` holds the two equal. */
export function panelUri(html: string): string {
  return entry.uri.replaceAll('{hash}', createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 12))
}

export const PANEL_URI = panelUri(panelHtml)

/** The entry: hidden from the model, it names the view, and a host with a
 *  side panel lists it there for the user to open. */
export const PANEL_ENTRY_TOOL = JSON.parse(JSON.stringify(entry.tool).replaceAll('{uri}', PANEL_URI)) as ToolDefinition

/** The view's own channel to the app (`panelSync.ts`), hidden from the model. */
export const PANEL_SYNC_TOOL: ToolDefinition = entry.sync

export const PANEL_RESOURCE = { uri: PANEL_URI, name: entry.resource.name, description: entry.resource.description, mimeType: entry.mimeType }

/** `resources/read` of `PANEL_URI`. */
export function readPanelResource(): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return { contents: [{ uri: PANEL_URI, mimeType: entry.mimeType, text: panelHtml }] }
}

/** What the entry tool answers: the host shows the view, and tells it this. */
export function panelEntryResult(): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: entry.result }] }
}

/** Whether a client's `initialize` capabilities say it shows MCP Apps views:
 *  the extension, naming the view's MIME type. Only such a client is listed
 *  the entry, the view and the sync tool; any other client gets neither them
 *  nor an answer to their names.
 *  LANDMINE: a host that shows views but does not declare this capability is
 *  never listed the entry, so its panel has nothing to open. The gate and its
 *  twin `declaresUI` in `cli/panel.go` change together; see docs/adr/0186,
 *  Consequences. */
export function declaresMcpAppsUi(capabilities: unknown): boolean {
  const ui = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined)?.extensions?.[entry.extension]
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(entry.mimeType)
}

/** A tool MCP Apps hides from the model: its `_meta.ui.visibility` leaves
 *  out "model". Every call of one is a view's, never the agent's. */
export function hiddenFromModel(definition: Pick<ToolDefinition, '_meta'>): boolean {
  const visibility = definition._meta?.ui?.visibility
  return Array.isArray(visibility) && !visibility.includes('model')
}
