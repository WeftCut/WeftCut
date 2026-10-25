// What the bench adds to a run's plan stage, outside the app: `check_plan`,
// the mechanical audit of a plan written as a timetable, and the prompt of the
// independent review that reads the plan in a fresh session. Both are general:
// nothing in them names a fixture or what its talk is about.

import path from 'node:path'
import { checkPlan, type Pace, type Plan, type Word } from './checkPlan'

/** The reviewer's skill: a role, and the footage tools for looking only. */
export const REVIEWER_SKILL = path.join(path.dirname(new URL(import.meta.url).pathname), 'reviewer-skill')

const RELATIONS = 'a sequence in time, a before and after, a comparison, a cause, a process, a place or a route, a part of a whole, a quantity, a person or a thing, a term'

export const CHECK_PLAN_DEF = {
  name: 'check_plan',
  description: 'Check a plan written as a timetable before showing it to the user. Pass the brief and one row per stretch of the talk, from her first word to her last. Finds what can be found without a frame: gaps, words not at the times given, reading time, animation steps off their words or too close, crowded cells, overlays that repeat her words, a relation carried by words alone, and the pace. Returns the findings and the plan as a table to present. Changes nothing.',
  inputSchema: { type: 'object', required: ['brief', 'rows'], properties: {
    brief: { type: 'object', properties: { audience: { type: 'string' }, message: { type: 'string' }, argument: { type: 'array', items: { type: 'string' } }, left_out: { type: 'array', items: { type: 'string' } } } },
    rows: { type: 'array', items: { type: 'object', required: ['id', 'start_s', 'end_s', 'words', 'claim', 'relation', 'picture', 'sees'], properties: {
      id: { type: 'string' }, start_s: { type: 'number' }, end_s: { type: 'number' },
      words: { type: 'string', description: 'Her words for this stretch, verbatim (or its first and last words).' },
      claim: { type: 'string' }, relation: { type: 'string', description: `What kind of idea the claim is: ${RELATIONS}, or another.` },
      picture: { type: 'string', enum: ['speaker', 'overlay', 'scene', 'animation'] },
      sees: { type: 'string' }, adds: { type: 'string' }, motif: { type: 'string' },
      elements: { type: 'array', items: { type: 'object', required: ['what', 'kind', 'region', 'size_pct', 'enter_s', 'leave_s'], properties: {
        what: { type: 'string' }, kind: { type: 'string', enum: ['picture', 'drawing', 'text', 'mark', 'animation'] }, text: { type: 'string' },
        region: { type: 'string', description: 'top-left, top, top-right, left, centre, right, bottom-left, bottom, bottom-right, or full' },
        size_pct: { type: 'number', description: 'Share of the frame height, 0–100.' }, enter_s: { type: 'number' }, leave_s: { type: 'number' }, source: { type: 'string' } } } },
      steps: { type: 'array', items: { type: 'object', required: ['at_s', 'word', 'what'], properties: { at_s: { type: 'number' }, word: { type: 'string' }, what: { type: 'string' } } } },
    } } },
  } },
} as const

/** check_plan's answer: a summary, the findings, and the table to present. */
export function runCheckPlan(args: unknown, words: Word[], pace: Pace | null): { text: string; findings: ReturnType<typeof checkPlan>['findings'] } {
  const r = checkPlan(args as Plan, words, pace)
  const hard = r.findings.filter((f) => f.severity === 'hard').length
  return { text: JSON.stringify({ summary: { hard, warning: r.findings.length - hard }, findings: r.findings, table: r.table }), findings: r.findings }
}

/** transcribe_clip's segments as timed lines, for the reviewer. */
export function transcriptLines(segments: Array<{ t_start_us: number; t_end_us: number; text: string }>): string {
  return segments.map((s) => `[${(s.t_start_us / 1e6).toFixed(1)}–${(s.t_end_us / 1e6).toFixed(1)}] ${s.text}`).join('\n')
}

/** The reviewer's prompt: the questions, her words with times, the plan as
 *  presented, and the plan as data when check_plan has seen it. */
export function reviewPrompt(transcript: string, planMessage: string, lastPlan: unknown): string {
  return [
    'You are reviewing the edit plan for an explainer video cut from a recorded talk. You did not write it, and you cannot change the project. The WeftCut tools are connected read-only: you may look at her footage (render_frames, read_project media_frame) to see what she shows.',
    '',
    'For each row, ask:',
    `1. What kind of idea is her claim: ${RELATIONS}?`,
    '2. Does the picture show that, by how it is arranged, or does it only share the topic?',
    '3. Is there a clearly better way to show it? For the hero moments, and for any row where the picture only shares the topic, give two or three other pictures, and say which you would choose and why.',
    'Then, across the plan: do the pictures form one visual system (an idea that returns gets its picture again; different processes get different pictures)? Is anything decorative, or does it repeat her words? Is the emphasis on the ideas the message needs?',
    '',
    'Reply with numbered notes, the most important first, at most 12. Each names the row, the problem and a concrete change. Say nothing about rows that are fine.',
    '',
    '## Transcript', transcript, '',
    '## The plan as presented to the user', planMessage, '',
    ...(lastPlan ? ['## The plan as data (the last check_plan call)', '```json', JSON.stringify(lastPlan), '```'] : []),
  ].join('\n')
}

/** What the stand-in user says when it hands the reviewer's notes back. */
export function reviewReply(notes: string): string {
  return `A reviewer who did not write the plan has read it. Their notes are below. Take the ones that make the video better and revise the timetable (check it again with check_plan); say in one line for each note whether you took it, and why. Then present the revised plan.\n\n${notes}`
}
