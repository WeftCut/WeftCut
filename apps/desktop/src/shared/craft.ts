// apps/desktop/src/shared/craft.ts
//
// The craft table: production rules as numbers (spec layer L1), the one source
// both `check_composition` and the skill's `craft/rules.md` read — the build
// renders the doc from this table, so the prose cannot drift from what the
// lint checks. A style may tighten a threshold through `tokens.floors`, never
// loosen it (`effectiveThreshold`).
//
// Rules enter as the agent bench surfaces the default they correct; the first
// set comes from the 2026-10-20 baseline (docs/notes/agent-bench-baseline-
// 2026-10-20.md).

export type CraftSeverity = 'hard' | 'warning' | 'review'

export interface CraftRule {
  id: string
  severity: CraftSeverity
  /** What the rule asks for, one line, for findings and the craft doc. */
  summary: string
  /** Why, in one line: the observed failure it prevents. */
  why: string
  /** Absent for a rule with no number. */
  threshold?: number
  unit?: 's' | 'chars' | 'lines' | 'fraction' | 'cuts' | 'per min'
  /** `min`: a value below the threshold fails; `max`: above. A floor moves
   *  the threshold only in the tightening direction. */
  direction?: 'min' | 'max'
}

export const CRAFT_RULES: readonly CraftRule[] = [
  { id: 'undeclared-role', severity: 'hard',
    summary: 'Every graphic role on a layer is built in or declared by the project\'s style or TASTE.md.',
    why: 'An undeclared role has no tokens and no checks; it is usually a typo.' },
  { id: 'text-offscreen', severity: 'hard',
    summary: 'A text layer has some part inside the frame.',
    why: 'Text placed wholly outside the frame renders nothing and still costs a layer.' },
  { id: 'title-hold', severity: 'warning', threshold: 3, unit: 's', direction: 'min',
    summary: 'A title stays on screen at least 3 s.',
    why: 'Every baseline explainer title was held 2.5–3.0 s, read once at best.' },
  { id: 'lower-third-hold', severity: 'warning', threshold: 4, unit: 's', direction: 'min',
    summary: 'A lower third stays on screen at least 4 s.',
    why: 'Two lines — a name and an affiliation — need about 4 s to be read twice; the baseline met it (4–7 s), the floor keeps it.' },
  { id: 'text-pops', severity: 'warning',
    summary: 'Titles and lower thirds enter and exit (intro and outro), never pop.',
    why: 'Every baseline run left intro and outro empty, so text cut on and off.' },
  { id: 'title-safe', severity: 'warning', threshold: 0.9, unit: 'fraction', direction: 'max',
    summary: 'Text stays inside the title-safe area, the centred 90 % of the frame.',
    why: 'Text at the frame edge is cropped by some players and crowds the picture.' },
  { id: 'motif-off-frame', severity: 'warning',
    summary: 'A Motif layer stays inside the frame, unless it covers the whole frame.',
    why: 'A name card placed with its centre near the edge lost a fifth of its width off screen; the audit checked text only.' },
  { id: 'overlay-echoes-speech', severity: 'warning',
    summary: 'An overlay shows what the speech does not: it never repeats the words said while it is up.',
    why: 'Every H2 run put the line being spoken on a quote card, over a caption of the same line: the same words three times.' },
  { id: 'bare-jump-cuts', severity: 'warning', threshold: 2, unit: 'cuts', direction: 'max',
    summary: 'At most 2 uncovered jump cuts in a row (cuts under 10 s apart); a scene, an insert or a punch-in covers the rest.',
    why: 'After removing pauses, 95–100 % of 26–78 jump cuts per H2/H3 run were left bare, even when the plan said to punch in.' },
  { id: 'bare-talk', severity: 'warning', threshold: 30, unit: 's', direction: 'max',
    summary: 'No stretch over 30 s with nothing on screen but the speaker.',
    why: 'Every H2/H3 run left a 59–75 s stretch of plain talking head.' },
  { id: 'sparse-beats', severity: 'warning', threshold: 30, unit: 's', direction: 'max',
    summary: 'Something new arrives on screen (an overlay, a scene, a scene element, an insert) at least every 30 s, or as often as the style\'s pace asks.',
    why: 'The post-23 runs placed about two graphic elements a minute, with up to 69 s between new arrivals.' },
  { id: 'scene-count', severity: 'warning', threshold: 0, unit: 'per min', direction: 'min',
    summary: 'As many animated scenes per minute of cut as the style\'s pace asks (none by default).',
    why: 'Agents built one scene in three minutes whatever the talk; a dense pace needs a number to meet.' },
  { id: 'word-heavy', severity: 'warning', threshold: 0.33, unit: 'fraction', direction: 'min',
    summary: 'At least a third of the graphic elements (titles, name cards and plates aside) are pictures: people, objects, places, documents, footage. Words label them.',
    why: 'H3 runs met an 8 s pace with headline after headline (3 pictures among about 45 elements): the cut read as words, not as a picture-led explainer.' },
  { id: 'captions-covered', severity: 'warning',
    summary: 'Captions stay visible: nothing opaque and full-frame (a scene, a plate, an insert) sits on a track above them while cues are up.',
    why: 'An H3 run put its scenes on tracks above the captions and hid them for 49 s.' },
  { id: 'scene-share', severity: 'warning', threshold: 0.5, unit: 'fraction', direction: 'max',
    summary: 'Full-frame scenes and plates cover at most half of the cut; the speaker stays the spine of a talk.',
    why: 'An H3 run turned the talk into a slideshow: nine scenes covering her for 110 of 183 s.' },
  { id: 'scene-all-words', severity: 'review',
    summary: 'A scene shows its idea in a picture (a photo, a still from the footage, a drawing), and words label it.',
    why: 'The first example scene was all words on paper (headlines, tags and reveals): it read as a slide, not an explanation.' },
  { id: 'caption-line-length', severity: 'warning', threshold: 42, unit: 'chars', direction: 'max',
    summary: 'A caption line holds at most 42 characters.',
    why: 'Transcription cues of 68–80 characters were laid down unbroken.' },
  { id: 'caption-lines', severity: 'warning', threshold: 2, unit: 'lines', direction: 'max',
    summary: 'A caption cue has at most 2 lines.',
    why: 'More lines cover the picture and cannot be read in the cue\'s time.' },
  { id: 'caption-cue-min', severity: 'warning', threshold: 1.2, unit: 's', direction: 'min',
    summary: 'A caption cue stays on screen at least 1.2 s.',
    why: 'Agents left 0.4 s cues that flash past.' },
  { id: 'caption-cue-max', severity: 'warning', threshold: 6, unit: 's', direction: 'max',
    summary: 'A caption cue stays on screen at most 6 s.',
    why: 'A long cue lags the speech it transcribes.' },
  { id: 'short-clip', severity: 'warning', threshold: 1, unit: 's', direction: 'min',
    summary: 'An A-roll clip is at least 1 s long.',
    why: 'Aggressive tightening left 0.28 s fragments — a jump-cut stutter.' },
  { id: 'role-inconsistency', severity: 'warning',
    summary: 'Text layers of one graphic role share family, size, weight and colour within a composition.',
    why: 'Two titles in two looks read as two different videos.' },
  { id: 'token-drift', severity: 'review',
    summary: 'A layer with a graphic role matches its role\'s style tokens.',
    why: 'A deliberate departure is fine; an accidental one is the inconsistency a style exists to prevent.' },
]

export function craftRule(id: string): CraftRule {
  const r = CRAFT_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`unknown craft rule ${id}`)
  return r
}

/** The threshold after a style's floor: only ever tighter than the craft
 *  number. A floor in the loosening direction is ignored (and reported by the
 *  caller). */
export function effectiveThreshold(rule: CraftRule, floor: number | undefined): number | undefined {
  if (rule.threshold === undefined || floor === undefined) return rule.threshold
  return rule.direction === 'min' ? Math.max(rule.threshold, floor) : Math.min(rule.threshold, floor)
}

/** The number a style holds a rule to: the craft threshold tightened by the
 *  style's floor, then by a token that asks for less (a style wanting
 *  32-character caption lines gets 32), never loosened by either. */
export function styleThreshold(id: string, floor?: number, token?: number): number {
  const rule = craftRule(id)
  return effectiveThreshold({ ...rule, threshold: effectiveThreshold(rule, floor) }, token) ?? 0
}

/** A style's pace (`tokens.pace`): how dense an edit is. Each key tightens
 *  one craft rule, as a floor does, and never loosens it. */
export interface PaceTokens { beat_every_s?: number; bare_talk_max_s?: number; scenes_per_min?: number; pictures_min_share?: number }

export const PACE_RULES: Readonly<Record<keyof PaceTokens, string>> = {
  beat_every_s: 'sparse-beats',
  bare_talk_max_s: 'bare-talk',
  scenes_per_min: 'scene-count',
  pictures_min_share: 'word-heavy',
}

/** The number a style holds a rule to, with its pace folded in. */
export function paceThreshold(id: string, tokens: { floors?: Record<string, number>; pace?: PaceTokens } | null | undefined): number {
  const key = (Object.keys(PACE_RULES) as Array<keyof PaceTokens>).find((k) => PACE_RULES[k] === id)
  return styleThreshold(id, tokens?.floors?.[id], key ? tokens?.pace?.[key] : undefined)
}

export interface StyleCaptionLimits { max_chars: number; max_lines: number; min_cue_s: number; max_cue_s: number }

/** The caption limits a style holds cues to — what `check_composition`
 *  checks and what `apply_transcripts` builds to. */
export function captionLimits(tokens: {
  floors?: Record<string, number>
  caption?: { max_chars_per_line?: number; max_lines?: number; min_cue_s?: number; max_cue_s?: number }
} | null | undefined): StyleCaptionLimits {
  const floors = tokens?.floors ?? {}, c = tokens?.caption ?? {}
  return {
    max_chars: styleThreshold('caption-line-length', floors['caption-line-length'], c.max_chars_per_line),
    max_lines: styleThreshold('caption-lines', floors['caption-lines'], c.max_lines),
    min_cue_s: styleThreshold('caption-cue-min', floors['caption-cue-min'], c.min_cue_s),
    max_cue_s: styleThreshold('caption-cue-max', floors['caption-cue-max'], c.max_cue_s),
  }
}

const fmt = (r: CraftRule) => r.threshold === undefined ? '—'
  : `${r.direction === 'min' ? '≥' : '≤'} ${r.unit === 'fraction' ? `${Math.round(r.threshold * 100)} %` : `${r.threshold} ${r.unit === 's' ? 's' : r.unit}`}`

/** `skills/weftcut/craft/rules.md`, rendered from the table above. The skill
 *  ships the file; `craft.test.ts` fails when it no longer matches. */
export function renderCraftRules(): string {
  const rows = CRAFT_RULES.map((r) => `| \`${r.id}\` | ${r.severity} | ${fmt(r)} | ${r.summary} | ${r.why} |`)
  return [
    '# Craft rules',
    '',
    'The numbers `check_composition` checks. Generated from',
    '`apps/desktop/src/shared/craft.ts`; edit the table there, not this file.',
    '',
    'Severity: `hard` must be fixed before handoff; `warning` is fixed or left',
    'as a tack with the reason; `review` is a departure to confirm, not a',
    'defect. A style tightens a number through `tokens.floors.<rule>` and never',
    'loosens it; caption tokens (`max_chars_per_line`, `max_lines`,',
    '`min_cue_s`, `max_cue_s`) tighten the caption rules the same way, and',
    'pace tokens (`tokens.pace`: `beat_every_s`, `bare_talk_max_s`,',
    '`scenes_per_min`, `pictures_min_share`) tighten `sparse-beats`,',
    '`bare-talk`, `scene-count` and `word-heavy`.',
    '',
    '| Rule | Severity | Threshold | Asks for | Why |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}
