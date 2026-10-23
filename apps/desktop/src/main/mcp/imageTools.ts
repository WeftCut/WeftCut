// apps/desktop/src/main/mcp/imageTools.ts
//
// `search_images` / `import_image` and `read_project { view: "credits" }`
// (ticket 32, ADR 0133). They run on the host, not the actor: they reach
// Wikimedia Commons, and the credit is kept beside the project, keyed by the
// pool item's content hash (`imageSearch.ts`).
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { TsActorHost } from '../state/ts-actor-host.js'
import { mcpDef } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'
import { runHybrid, type HybridDeps } from '../state/hybrids.js'
import { downloadImage, lookupImage, readCredits, searchImages, writeCredit, type ImageCandidate } from '../imageSearch.js'
import { toolErrorResult } from './toolResult.js'

export const IMAGE_TOOLS: ReadonlySet<string> = new Set(['search_images', 'import_image'])

export interface ImageToolEnv {
  /** Where downloads land before `import_media` copies them into the project. */
  downloadDir: string
  /** The user's Settings switch (`agent_image_search`). */
  enabled: () => boolean
  fetch?: typeof globalThis.fetch
}

let env: ImageToolEnv | null = null
/** Wired once from main; until then the tools refuse. */
export function setImageToolEnv(e: ImageToolEnv): void { env = e }

const THUMB_BYTES = 2 * 1024 * 1024

async function thumbnail(c: ImageCandidate, fetchFn: typeof globalThis.fetch): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetchFn(c.thumb_url, { headers: { 'User-Agent': 'WeftCut/0.5 (open-licence picture search; https://github.com/WeftCut/WeftCut)' }, signal: AbortSignal.timeout(10_000) })
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    return bytes.length > THUMB_BYTES ? null : { data: bytes.toString('base64'), mimeType: mime }
  } catch { return null }
}

export async function runImageTool(
  host: Pick<TsActorHost, 'openedProject' | 'actor' | 'hybridDeps'>,
  name: string,
  args: Record<string, unknown>,
  by: Parameters<TsActorHost['hybridDeps']['actor']['dispatch']>[2],
): Promise<ServerResult> {
  if (!env) return toolErrorResult({ code: 'internal', message: `${name} is not available in this host. Nothing was changed.` })
  if (!env.enabled()) return toolErrorResult({ code: 'invalid_request', message: 'The user has turned off image search (Settings → Let agents search open image libraries). Use their media, a still from the footage, or a drawing; or ask them to turn it on. Nothing was changed.', data: { error: 'ImageSearchOff' } })
  const fetchFn = env.fetch ?? globalThis.fetch
  const p = mcpDef(name).parseDedicated!(args)

  if (name === 'search_images') {
    let found: ImageCandidate[]
    try { found = await searchImages(p.query as string, { limit: p.limit as number, fetch: fetchFn as never }) }
    catch (e) { return toolErrorResult({ code: 'internal', message: `Searching Wikimedia Commons failed: ${(e as Error).message}. Try again, or use a drawing.` }) }
    if (!found.length) return { content: [{ type: 'text', text: JSON.stringify({ candidates: [], note: `Nothing on Wikimedia Commons for "${p.query as string}" under a licence that allows changes and commercial use. Try other words (a name, the thing, its English name), or draw it.` }) }] } as unknown as ServerResult
    const thumbs = await Promise.all(found.map((c) => thumbnail(c, fetchFn)))
    const content: Array<Record<string, unknown>> = []
    found.forEach((c, i) => {
      content.push({ type: 'text', text: `${i + 1}. ${c.candidate_id} · ${c.title} · ${c.width}×${c.height} · ${c.license}` })
      const t = thumbs[i]
      if (t) content.push({ type: 'image', data: t.data, mimeType: t.mimeType })
    })
    const record = { candidates: found.map(({ thumb_url: _t, image_url: _u, ...c }) => c) }
    content.push({ type: 'text', text: JSON.stringify(record) })
    return { content } as unknown as ServerResult
  }

  // import_image
  const opened = host.openedProject?.() ?? null
  if (!opened) return toolErrorResult({ code: 'invalid_request', message: 'No project is open. Nothing was changed.' })
  let c: ImageCandidate, file: string
  try {
    c = await lookupImage(p.candidate_id as string, { fetch: fetchFn as never })
    file = await downloadImage(c, env.downloadDir, { fetch: fetchFn as never })
  } catch (e) { return toolErrorResult({ code: 'invalid_params', message: `${(e as Error).message}. Nothing was imported.`, data: { field: 'candidate_id' } }) }
  const actor = host.hybridDeps.actor
  const deps: HybridDeps = { ...host.hybridDeps, actor: { ...actor, dispatch: (cmd: string, a: Record<string, unknown>) => actor.dispatch(cmd, a, by) } }
  const mediaId = String(await runHybrid('import_media', { path: file }, deps))
  const item = host.actor.snapshot().media_pool[mediaId]
  if (!item) return toolErrorResult({ code: 'internal', message: `The download of ${c.candidate_id} was imported but is no longer in the pool.` })
  writeCredit(opened.dir, item.file_hash_blake3, {
    title: c.title, author: c.author, license: c.license, license_url: c.license_url, page_url: c.page_url,
    source: c.source, credit: c.credit, imported_at: new Date().toISOString(),
  })
  const video = (item.metadata as { video?: { width?: number; height?: number } | null }).video
  return toolRecord({ media_id: item.id, label: item.label, width: video?.width ?? c.width, height: video?.height ?? c.height, license: c.license, credit: c.credit, page_url: c.page_url }) as unknown as ServerResult
}

/** `read_project { view: "credits" }`: every pool item with a recorded credit,
 *  and whether a layer or a Motif prop in any composition uses it. */
export function creditsView(host: Pick<TsActorHost, 'openedProject' | 'actor'>): Record<string, unknown> {
  const opened = host.openedProject?.() ?? null
  if (!opened) return { credits: [] }
  const credits = readCredits(opened.dir)
  const snap = host.actor.snapshot()
  const used = new Set<string>()
  for (const comp of Object.values(snap.compositions)) for (const t of comp.tracks) for (const l of t.layers) {
    const prm = l.params as { kind: string; media?: string; props?: Record<string, unknown> }
    if (typeof prm.media === 'string') used.add(prm.media)
    if (prm.kind === 'Motif') for (const v of Object.values(prm.props ?? {})) if (typeof v === 'string') used.add(v.split('@')[0]!)
  }
  const list = Object.values(snap.media_pool).filter((m) => credits[m.file_hash_blake3]).map((m) => ({ media_id: m.id, label: m.label, used: used.has(m.id), ...credits[m.file_hash_blake3]! }))
  return { credits: list }
}
