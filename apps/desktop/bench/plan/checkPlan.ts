// Prototype of `check_plan`: mechanical checks on a plan written as a
// timetable. It judges no design; it finds what can be found without seeing a
// frame, so a review (and the user) can spend their attention on the design.

export interface PlanElement {
  what: string
  kind: 'picture' | 'drawing' | 'text' | 'mark' | 'animation'
  text?: string
  region: string
  size_pct: number
  enter_s: number
  leave_s: number
  source?: string
}
export interface PlanStep { at_s: number; word: string; what: string }
export interface PlanRow {
  id: string
  start_s: number
  end_s: number
  words: string
  claim: string
  relation: string
  picture: 'speaker' | 'overlay' | 'scene' | 'animation'
  sees: string
  adds?: string
  elements?: PlanElement[]
  steps?: PlanStep[]
  motif?: string
}
export interface Plan {
  brief?: { audience?: string; message?: string; argument?: string[]; left_out?: string[] }
  rows: PlanRow[]
}
export interface Word { t_start_us: number; t_end_us: number; text: string }
export interface Pace { beat_every_s?: number; bare_talk_max_s?: number; scenes_per_min?: number }
export interface Finding { rule: string; severity: 'hard' | 'warning'; row?: string; message: string }

const REGIONS = ['top-left', 'top', 'top-right', 'left', 'centre', 'right', 'bottom-left', 'bottom', 'bottom-right', 'full']
/** Relations a picture can show by its arrangement, not only by naming. */
const STRUCTURAL = /before|after|sequence|order|timeline|time|compar|contrast|versus|\bvs\b|cause|because|effect|process|mechanism|steps?\b|place|route|map|where|part|whole|quantit|scale|number|change|grow|transform/i

const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean)
const s1 = (n: number) => n.toFixed(1)

export function checkPlan(plan: Plan, words: Word[], pace: Pace | null): { findings: Finding[]; table: string } {
  const out: Finding[] = []
  const add = (rule: string, severity: Finding['severity'], row: string | undefined, message: string) => out.push({ rule, severity, ...(row ? { row } : {}), message })
  const W = words.map((w) => ({ s: w.t_start_us / 1e6, e: w.t_end_us / 1e6, t: tokens(w.text)[0] ?? '' }))
  const said = (a: number, b: number) => W.filter((w) => w.e > a && w.s < b).map((w) => w.t)
  const first = W[0]?.s ?? 0, last = W.at(-1)?.e ?? 0

  if (!plan.brief?.message) add('no-brief', 'hard', undefined, 'The plan states no message: the one thing a viewer should understand.')
  const rows = [...(plan.rows ?? [])].sort((a, b) => a.start_s - b.start_s)
  if (!rows.length) { add('no-rows', 'hard', undefined, 'The plan has no rows.'); return { findings: out, table: '' } }

  // Coverage: every second of her talk is in exactly one row.
  if (rows[0].start_s > first + 1) add('gap', 'hard', rows[0].id, `Nothing is planned for ${s1(first)}–${s1(rows[0].start_s)} s.`)
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], r = rows[i]
    if (r.start_s - p.end_s > 1) add('gap', 'hard', r.id, `Nothing is planned for ${s1(p.end_s)}–${s1(r.start_s)} s, between rows ${p.id} and ${r.id}.`)
    if (p.end_s - r.start_s > 0.2) add('overlap', 'hard', r.id, `Rows ${p.id} and ${r.id} overlap (${s1(r.start_s)}–${s1(p.end_s)} s). One row per stretch; an element may run on into the next row.`)
  }
  if (rows.at(-1)!.end_s < last - 1) add('gap', 'hard', rows.at(-1)!.id, `Nothing is planned after ${s1(rows.at(-1)!.end_s)} s; she talks until ${s1(last)} s.`)

  let sceneS = 0
  const arrivals: number[] = []
  const shown: Array<[number, number]> = []
  for (const r of rows) {
    for (const f of ['claim', 'relation', 'sees'] as const) if (!String(r[f] ?? '').trim()) add('missing-field', 'hard', r.id, `Row ${r.id} has no ${f}.`)
    if (r.picture !== 'speaker' && !String(r.adds ?? '').trim()) add('missing-field', 'hard', r.id, `Row ${r.id} has no "adds": what its picture shows that her words do not.`)
    // Her words are where the row says.
    const q = tokens(r.words ?? '')
    if (q.length) {
      const near = said(r.start_s - 1.5, r.end_s + 1.5)
      const hit = q.filter((t) => near.includes(t)).length / q.length
      if (hit < 0.6) add('words-not-there', 'hard', r.id, `"${r.words}" is not what she says at ${s1(r.start_s)}–${s1(r.end_s)} s. Take the times from transcribe_clip's words.`)
    }
    if (r.picture === 'scene' || r.picture === 'animation') sceneS += r.end_s - r.start_s
    if (r.picture === 'animation' && !(r.steps?.length)) add('animation-without-steps', 'hard', r.id, `Row ${r.id} is an animation with no steps on her words.`)

    // Steps: in order, on her words, with time to read each.
    const steps = r.steps ?? []
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]
      arrivals.push(st.at_s)
      if (i && st.at_s <= steps[i - 1].at_s) add('steps-order', 'hard', r.id, `Row ${r.id}: step ${i + 1} (${s1(st.at_s)} s) does not come after step ${i} (${s1(steps[i - 1].at_s)} s).`)
      else if (i && st.at_s - steps[i - 1].at_s < 1.5) add('steps-crowded', 'warning', r.id, `Row ${r.id}: step ${i + 1} starts ${s1(st.at_s - steps[i - 1].at_s)} s after step ${i}; the viewer cannot see one finish before the next begins. Give each step at least 1.5 s, or merge them.`)
      const w = W.find((x) => Math.abs(x.s - st.at_s) <= 0.4 && (!st.word || tokens(st.word).includes(x.t)))
      if (!w) add('step-off-word', 'warning', r.id, `Row ${r.id}: step ${i + 1} at ${s1(st.at_s)} s is not on "${st.word}"; she says ${said(st.at_s - 0.5, st.at_s + 0.5).join(' ') || 'nothing'} there.`)
      if (st.at_s < r.start_s - 0.5 || st.at_s > r.end_s + 0.5) add('outside-row', 'warning', r.id, `Row ${r.id}: step ${i + 1} at ${s1(st.at_s)} s is outside the row (${s1(r.start_s)}–${s1(r.end_s)} s).`)
    }

    const els = r.elements ?? []
    for (const e of els) {
      arrivals.push(e.enter_s)
      shown.push([e.enter_s, e.leave_s])
      if (!REGIONS.includes(e.region)) add('region', 'warning', r.id, `Row ${r.id}: "${e.what}" sits in "${e.region}"; use a cell of the 3×3 grid (${REGIONS.join(', ')}).`)
      if (e.leave_s <= e.enter_s) add('element-span', 'hard', r.id, `Row ${r.id}: "${e.what}" leaves before it enters.`)
      if (e.enter_s < r.start_s - 0.5 || e.enter_s > r.end_s) add('outside-row', 'warning', r.id, `Row ${r.id}: "${e.what}" enters at ${s1(e.enter_s)} s, outside the row.`)
      if (e.text) {
        const n = tokens(e.text).length, need = 1 + n / 3
        if (e.leave_s - e.enter_s < need) add('too-short-to-read', 'warning', r.id, `Row ${r.id}: "${e.text}" is on for ${s1(e.leave_s - e.enter_s)} s; ${n} words need about ${s1(need)} s.`)
        const tk = tokens(e.text)
        if (tk.length >= 3) {
          const near = said(e.enter_s - 2, e.leave_s + 2)
          if (tk.filter((t) => near.includes(t)).length / tk.length >= 0.7) add('echo', 'warning', r.id, `Row ${r.id}: "${e.text}" repeats what she says as it shows. The captions already carry it; show what the words leave out.`)
        }
      }
    }
    // Two things in one cell at once.
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j]
      if (a.region === b.region && a.region !== 'full' && Math.min(a.leave_s, b.leave_s) - Math.max(a.enter_s, b.enter_s) > 0.5)
        add('crowded-cell', 'warning', r.id, `Row ${r.id}: "${a.what}" and "${b.what}" share the ${a.region} cell at the same time.`)
    }
    // A relation the picture could show, carried by words alone.
    if (r.picture !== 'speaker' && STRUCTURAL.test(r.relation ?? '') && els.length && els.every((e) => e.kind === 'text' || e.kind === 'mark'))
      add('relation-in-words', 'warning', r.id, `Row ${r.id} is "${r.relation}", but only words and marks carry it. Say how the picture itself shows it, or why words are enough here.`)
  }

  const span = last - first
  if (span > 0 && sceneS / span > 0.5) add('scene-share', 'warning', undefined, `Scenes and animations cover ${Math.round((100 * sceneS) / span)} % of the talk; keep the speaker the spine (at most half).`)
  if (pace?.beat_every_s) {
    const at = [first, ...arrivals.filter((t) => t >= first && t <= last).sort((a, b) => a - b), last]
    for (let i = 1; i < at.length; i++) if (at[i] - at[i - 1] > pace.beat_every_s + 0.5)
      add('sparse-beats', 'warning', undefined, `Nothing new arrives for ${s1(at[i] - at[i - 1])} s (${s1(at[i - 1])}–${s1(at[i])} s); the pace asks for something every ${pace.beat_every_s} s.`)
  }
  if (pace?.bare_talk_max_s) {
    const cover = [...shown, ...rows.filter((r) => r.picture === 'scene' || r.picture === 'animation').map((r) => [r.start_s, r.end_s] as [number, number])].sort((a, b) => a[0] - b[0])
    let t = first
    for (const [a, b] of cover) { if (a - t > pace.bare_talk_max_s) add('bare-talk', 'warning', undefined, `Only the speaker for ${s1(a - t)} s (${s1(t)}–${s1(a)} s); the pace allows ${pace.bare_talk_max_s} s.`); t = Math.max(t, b) }
    if (last - t > pace.bare_talk_max_s) add('bare-talk', 'warning', undefined, `Only the speaker for ${s1(last - t)} s at the end.`)
  }

  return { findings: out, table: render(plan, rows) }
}

const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
function render(plan: Plan, rows: PlanRow[]): string {
  const b = plan.brief ?? {}
  const lines = [
    `**Message:** ${cell(b.message)}`,
    ...(b.argument?.length ? [`**Argument:** ${b.argument.map((a, i) => `${i + 1}. ${cell(a)}`).join(' ')}`] : []),
    '',
    '| # | Time | Her words | Relation | The viewer sees | It adds |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${s1(r.start_s)}–${s1(r.end_s)} | ${cell(r.words)} | ${cell(r.relation)} | ${cell(r.sees)} | ${cell(r.adds)} |`),
  ]
  return lines.join('\n')
}
