# Craft rules

The numbers `check_composition` checks. Generated from
`apps/desktop/src/shared/craft.ts`; edit the table there, not this file.

Severity: `hard` must be fixed before handoff; `warning` is fixed or left
as a tack with the reason; `review` is a departure to confirm, not a
defect. A style tightens a number through `tokens.floors.<rule>` and never
loosens it; caption tokens (`max_chars_per_line`, `max_lines`,
`min_cue_s`, `max_cue_s`) tighten the caption rules the same way, and
pace tokens (`tokens.pace`: `beat_every_s`, `bare_talk_max_s`,
`scenes_per_min`, `pictures_min_share`) tighten `sparse-beats`,
`bare-talk`, `scene-count` and `word-heavy`.

| Rule | Severity | Threshold | Asks for | Why |
|---|---|---|---|---|
| `undeclared-role` | hard | — | Every graphic role on a layer is built in or declared by the project's style or TASTE.md. | An undeclared role has no tokens and no checks; it is usually a typo. |
| `text-offscreen` | hard | — | A text layer has some part inside the frame. | Text placed wholly outside the frame renders nothing and still costs a layer. |
| `title-hold` | warning | ≥ 3 s | A title stays on screen at least 3 s. | Every baseline explainer title was held 2.5–3.0 s, read once at best. |
| `lower-third-hold` | warning | ≥ 4 s | A lower third stays on screen at least 4 s. | Two lines — a name and an affiliation — need about 4 s to be read twice; the baseline met it (4–7 s), the floor keeps it. |
| `text-pops` | warning | — | Titles and lower thirds enter and exit (intro and outro), never pop. | Every baseline run left intro and outro empty, so text cut on and off. |
| `title-safe` | warning | ≤ 90 % | Text stays inside the title-safe area, the centred 90 % of the frame. | Text at the frame edge is cropped by some players and crowds the picture. |
| `motif-off-frame` | warning | — | A Motif layer stays inside the frame, unless it covers the whole frame. | A name card placed with its centre near the edge lost a fifth of its width off screen; the audit checked text only. |
| `overlay-echoes-speech` | warning | — | An overlay shows what the speech does not: it never repeats the words said while it is up. | Every H2 run put the line being spoken on a quote card, over a caption of the same line: the same words three times. |
| `bare-jump-cuts` | warning | ≤ 2 cuts | At most 2 uncovered jump cuts in a row (cuts under 10 s apart); a scene, an insert or a punch-in covers the rest. | After removing pauses, 95–100 % of 26–78 jump cuts per H2/H3 run were left bare, even when the plan said to punch in. |
| `bare-talk` | warning | ≤ 30 s | No stretch over 30 s with nothing on screen but the speaker. | Every H2/H3 run left a 59–75 s stretch of plain talking head. |
| `sparse-beats` | warning | ≤ 30 s | Something new arrives on screen (an overlay, a scene, a scene element, an insert) at least every 30 s, or as often as the style's pace asks. | The post-23 runs placed about two graphic elements a minute, with up to 69 s between new arrivals. |
| `scene-count` | warning | ≥ 0 per min | As many animated scenes per minute of cut as the style's pace asks (none by default). | Agents built one scene in three minutes whatever the talk; a dense pace needs a number to meet. |
| `word-heavy` | warning | ≥ 33 % | At least a third of the graphic elements (titles, name cards and plates aside) are pictures: people, objects, places, documents, footage. Words label them. | H3 runs met an 8 s pace with headline after headline (3 pictures among about 45 elements): the cut read as words, not as a picture-led explainer. |
| `still-scenes` | warning | ≥ 33 % | In a cut with two or more scenes, at least a third of them are drawn animations of what is said (a process moving, a structure building), not pictures and words on paper. | H4 runs built every scene from stickers, labels and tape; the user asked for the neuron passage to show neurons linking and signalling. |
| `captions-covered` | warning | — | Captions stay visible: nothing opaque and full-frame (a scene, a plate, an insert) sits on a track above them while cues are up. | An H3 run put its scenes on tracks above the captions and hid them for 49 s. |
| `scene-share` | warning | ≤ 50 % | Full-frame scenes and plates cover at most half of the cut; the speaker stays the spine of a talk. | An H3 run turned the talk into a slideshow: nine scenes covering her for 110 of 183 s. |
| `scene-all-words` | review | — | A scene shows its idea in a picture (a photo, a still from the footage, a drawing), and words label it. | The first example scene was all words on paper (headlines, tags and reveals): it read as a slide, not an explanation. |
| `caption-line-length` | warning | ≤ 42 chars | A caption line holds at most 42 characters. | Transcription cues of 68–80 characters were laid down unbroken. |
| `caption-lines` | warning | ≤ 2 lines | A caption cue has at most 2 lines. | More lines cover the picture and cannot be read in the cue's time. |
| `caption-cue-min` | warning | ≥ 1.2 s | A caption cue stays on screen at least 1.2 s. | Agents left 0.4 s cues that flash past. |
| `caption-cue-max` | warning | ≤ 6 s | A caption cue stays on screen at most 6 s. | A long cue lags the speech it transcribes. |
| `short-clip` | warning | ≥ 1 s | An A-roll clip is at least 1 s long. | Aggressive tightening left 0.28 s fragments — a jump-cut stutter. |
| `role-inconsistency` | warning | — | Text layers of one graphic role share family, size, weight and colour within a composition. | Two titles in two looks read as two different videos. |
| `token-drift` | review | — | A layer with a graphic role matches its role's style tokens. | A deliberate departure is fine; an accidental one is the inconsistency a style exists to prevent. |
