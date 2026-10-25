# Craft rules

The numbers `check_composition` checks. Generated from
`apps/desktop/src/shared/craft.ts`; edit the table there, not this file.

Severity: `hard` must be fixed before handoff; `warning` is fixed or left
as a tack with the reason; `review` is a departure to confirm, not a
defect. A style tightens a number through `tokens.floors.<rule>` and never
loosens it; caption tokens (`max_chars_per_line`, `max_lines`,
`min_cue_s`, `max_cue_s`) tighten the caption rules the same way.

| Rule | Severity | Threshold | Asks for | Why |
|---|---|---|---|---|
| `undeclared-role` | hard | — | Every graphic role on a layer is built in or declared by the project's style or TASTE.md. | An undeclared role has no tokens and no checks; it is usually a typo. |
| `text-offscreen` | hard | — | A text layer has some part inside the frame. | Text placed wholly outside the frame renders nothing and still costs a layer. |
| `title-hold` | warning | ≥ 3 s | A title stays on screen at least 3 s. | Every baseline explainer title was held 2.5–3.0 s, read once at best. |
| `lower-third-hold` | warning | ≥ 4 s | A lower third stays on screen at least 4 s. | Two lines — a name and an affiliation — need about 4 s to be read twice; the baseline met it (4–7 s), the floor keeps it. |
| `text-pops` | warning | — | Titles and lower thirds enter and exit (intro and outro), never pop. | Every baseline run left intro and outro empty, so text cut on and off. |
| `title-safe` | warning | ≤ 90 % | Text stays inside the title-safe area, the centred 90 % of the frame. | Text at the frame edge is cropped by some players and crowds the picture. |
| `motif-off-frame` | warning | — | A Motif layer stays inside the frame, unless it covers the whole frame. | A name card placed with its centre near the edge lost a fifth of its width off screen; the audit checked text only. |
| `captions-covered` | warning | — | Captions stay visible: nothing opaque and full-frame (a scene, a plate, an insert) sits on a track above them while cues are up. | An H3 run put its scenes on tracks above the captions and hid them for 49 s. |
| `caption-line-length` | warning | ≤ 42 chars | A caption line holds at most 42 characters. | Transcription cues of 68–80 characters were laid down unbroken. |
| `caption-lines` | warning | ≤ 2 lines | A caption cue has at most 2 lines. | More lines cover the picture and cannot be read in the cue's time. |
| `caption-cue-min` | warning | ≥ 1.2 s | A caption cue stays on screen at least 1.2 s. | Agents left 0.4 s cues that flash past. |
| `caption-cue-max` | warning | ≤ 6 s | A caption cue stays on screen at most 6 s. | A long cue lags the speech it transcribes. |
| `short-clip` | warning | ≥ 1 s | An A-roll clip is at least 1 s long. | Aggressive tightening left 0.28 s fragments — a jump-cut stutter. |
| `role-inconsistency` | warning | — | Text layers of one graphic role share family, size, weight and colour within a composition. | Two titles in two looks read as two different videos. |
| `token-drift` | review | — | A layer with a graphic role matches its role's style tokens. | A deliberate departure is fine; an accidental one is the inconsistency a style exists to prevent. |
