# WeftCut

WeftCut is an Electron + napi-rs desktop video editor. This file is the
project's glossary — the canonical word for each domain concept. It holds no
implementation detail; the shape of the data lives in [`docs/data-model.md`](docs/data-model.md)
and the decisions in [`docs/adr/`](docs/adr/).

## Decode routing

**Decode Route**:
The per-source decision of where preview and where export each read their
pixels from — one of Bypass, DirectExport, or Proxied. Distinct from a
source's *readiness* (whether the file the route names has been generated yet).
_Avoid_: proxy plan, proxy mode, routing flags

**Bypass**:
A Decode Route where preview and export both read the original source directly;
no proxy is ever made.
_Avoid_: direct, no-proxy, direct-both

**DirectExport**:
A Decode Route where export reads the original source and preview reads a quick
proxy.
_Avoid_: original-export, direct-export-quick-preview

**Proxied**:
A Decode Route where preview reads a quick proxy and export reads an export
master.
_Avoid_: full-proxy, transcoded

**Quick proxy**:
A small, short-GOP scrub copy of a source, used only as a preview source —
never an export source.
_Avoid_: preview proxy, scrub proxy, proxy (unqualified)

**Export master**:
A source-resolution copy of a source that WebCodecs can decode, used only as an
export source — never a preview source.
_Avoid_: full proxy, proxy (unqualified)

**Session bridge**:
Formerly: machine-specific, non-persisted knowledge that this machine can
decode a source's original, letting preview read the original before any
proxy lands. That behavior is now the ordinary outcome of the [Decode
engine](#decode-routing) resolving the Lite engine on an original whenever
WebCodecs can decode it. The term names only the residual WebCodecs-original
probe memo the resolver still consults, on its way to full retirement.
_Avoid_: decode memo, probe cache

**Decode engine**:
The runtime overlay that resolves, per source and per session, an **engine**
(Standard or Lite) and a **source** (original or proxy) — from the
decode-engine setting, the [Capability cache](#decode-routing), and the
source's read-only Decode Route. Hardware-vs-software is private to the
Standard engine, never part of the resolution. Preview re-resolves every
session; export resolves once at export start into a frozen per-media
routing table (`resolveExportDecodeRouting`, ADR 0033) and never mid-run.
What persists is only the user's *intent* (the app-level preview setting;
the per-project export `decodeEngine`), never a resolution.
_Avoid_: decode route (that's the persisted disk truth), tier, preset

**Standard engine**:
The FFmpeg decode engine (setting value `ffmpeg`) — decodes any original
in-process, privately choosing a hardware (d3d11va shared-texture) or software
(NV12-over-IPC) lane. Needs the optional native-decode component.
_Avoid_: native engine, ffmpeg lane

**Lite engine**:
The WebCodecs decode engine (setting value `webcodecs`) — the compatibility
floor, always present, decodes whatever the browser's WebCodecs can open.
_Avoid_: webcodecs lane, browser decoder

**Automatic**:
The default decode-engine setting (`auto`): resolves to the Standard engine
when its component is loaded and hasn't failed for the source, otherwise the
Lite engine. Not itself an engine — a resolution rule.
_Avoid_: auto engine

**Unsupported**:
The Decode engine resolution state when the chosen engine cannot decode the
chosen source (the Lite engine on an original WebCodecs can't open, or a
pinned Standard engine with no component). Surfaced as a placeholder card with
a Switch-to-Standard action — never a silent proxy swap.
_Avoid_: unplayable, black frame, fallback

**Capability cache**:
Machine-level probe verdicts — can this machine's decoders open a given
format/lane — keyed by format class, persisted by main and invalidated when
the component's ffmpeg changes. A property of the machine, never of a
project.
_Avoid_: session bridge, decode memo

## Transitions

**Transition direction**:
The **motion** direction of a Wipe or Slide, never the reveal side (industry
convention): `Wipe left` = the reveal boundary sweeps right-to-left across
the frame; `Slide left` = the incoming layer enters from the right edge
moving left. Agents consume the enum directly, so this reading is the wire
contract's meaning (ADR 0035).
_Avoid_: reveal side, wipe from, source edge

**Overlap placement**:
The default arrangement of every `add_transition`: the incoming layer moves
left by the frame-rounded duration (link siblings following on their own
lattices), so both participants play exactly their trimmed ranges — no
default touches the user's cut (ADR 0048). The vacated span stays a gap
(links, not ripple, express "these move together"), and a shifted sibling
that collides on its lane bounces to a free one.
_Avoid_: start-at-cut, auto-extend, handle-checked add, silent extend fallback

**extended_us / borrowed handle**:
The per-transition counter of borrowed outgoing-tail µs: `0` = pure
placement, and the outgoing layer's sacred end — the exit frame the user
cut — is always `t_end_us − extended_us`. Inverse operations route by it
(removal shrinks the outgoing layer by `extended_us`, moves the incoming
layer right by the remainder). Only the chip's right edge or an explicit
patch raises it; implicit duration changes are sanctity-preferring
(ADR 0048).
_Avoid_: placement enum, extend flag, handle-consumption mode

## Transform

**Linked scale**:
A layer state (`Transform.scale_linked`, default on) in which the two scale
tracks are structural twins and every editing surface shows and writes them as
one "Scale". Not a keyframe mode — `Animated` stays Static/Keyframed; linking
is editor behavior plus a self-healing flag: any write that diverges the pair
clears it in the same commit, and re-linking snaps `scale_y` to a copy of
`scale_x`.
_Avoid_: uniform-scale mode, scale lock, third keyframe mode

## Text box

**Text box**:
The rectangle a Text layer lays its glyphs out in (`TextParams.box_w`/`box_h`,
composition pixels, local — before `scale`). Text is the only visual kind with
no intrinsic size, and the box is what supplies one: the preview's resize
handles write it, the transform anchor is taken over it, and the font size in
the inspector is what reaches the frame at any box size. It lays out; it never
magnifies — enlarging a title must not enlarge its letters. Whole-layer
magnification is still `scale`, which is also the only animatable one of the two
(ADR 0049).
_Avoid_: text frame, bounding box, text bounds (those are the measured glyphs)

**Resize mode**:
Which of Auto width, Auto height or Fixed a Text layer is in — **read off**
which box fields are set (`(null, null)`, `(set, null)`, `(set, set)`), never
stored. Same discipline as linked scale: the state is its own consequences, so
no flag can contradict them. `(null, set)` is not a fourth mode — a gesture
backfills the width in the same commit, and a writer that cannot measure
refuses.
_Avoid_: resize enum, box mode, auto-size flag

**Shrink-to-fit**:
Fixed's answer to text that overruns its box: the largest font size whose
measured block fits, with every other length authored against the glyphs — the
outline width, the shadow offsets, the leading and the tracking — multiplied by
the same factor. Derived at render time and never written back — the layer keeps
exactly one font size, the one the user set — and floored at 8 px absolute,
below which the text overflows and is marked instead. Belongs to Fixed alone;
Auto height overflows horizontally rather than shrinking.
_Avoid_: auto-fit, scale-to-fit, effective font size (that is the derived
number, not the behavior)

## Track placement

**Track**:
The kind-agnostic container a layer sits in — the data object (`Project.tracks`,
ordered bottom-of-z-stack first). Not something the user provisions: tracks
appear and disappear around where media is placed (ADR 0042), so there is no
add, remove or reorder surface for one.
_Avoid_: channel, layer container, timeline row (that is the lane)

**Lane**:
A track's rendered row in the timeline — the presentation, not the object
(`TrackLane.tsx`, `laneEls`). Say lane when the subject is the row on screen and
track when it is the thing holding layers. Unrelated to a decode engine's
hardware / software lane, which is a decode path.
_Avoid_: lane as a synonym for track in data-model or command prose

**Reserved skeleton**:
The role-stamped tracks a blank project ships with — A roll, B roll, and the
audio-role tracks derived from them. Non-removable, never swept by cleanup, and
the reason "no tracks exist" is never a case the UI handles. Carrying a `role`
is exactly what makes a track part of it.
_Avoid_: default tracks, system tracks, fixed tracks

**Track display**:
The app-level filter over which lanes the timeline shows (`display_mode`,
persisted). **A/B Roll** — the default — keeps only role-stamped tracks, plus at
most one inline-revealed hidden lane; **All Tracks** keeps every one. Those two
names are the term at every surface: the View menu radio, the Quick Actions
toggle, the `T` binding's label, and the `AbRoll` / `AllTracks` enum. Chinese
leaves A/B Roll untranslated — it is the term the industry says — and calls the
other 全轨显示. Capitalisation carries the mode/lane distinction: A/B Roll is the
mode, *A/B-roll tracks* the lanes it keeps.
_Avoid_: Show All, AB mode, A/B view filter, "Display: A/B Roll only"

**Transient**:
The `Track.transient` flag, read as *not part of the reserved skeleton* —
stamped on every track whose `role` is `None`, including one an agent creates
deliberately. The name predates the meaning and reads like "temporary", which it
is not: the flag says a track is eligible for cleanup, not that it is doomed.
The invariant is `transient == (role is None)` at every creation site.
_Avoid_: temporary track, scratch track, auto track

**Derived name**:
The name a track is shown under when it stores none (`label === null`, blank
counting as absent) — from its `role` for the reserved skeleton, otherwise a
positional number that renumbers as tracks come and go. Computed at display time
in the renderer, never stored, because only the renderer can localize it.
`trackName.ts` is the single answer for every surface.
_Avoid_: auto label, placeholder name, default label

**Cleanup**:
The one rule that removes a track: *a track disappears when its last layer
leaves it* — `transient && !locked`, applied to the track an edit just emptied,
never as a project-wide sweep. A track that was born empty was never emptied, so
one an agent creates on purpose survives.
_Avoid_: prune (that is the function), auto-delete, garbage collection

**Marker lane**:
The permanently reserved row between the ruler and the drop strip that carries a
composition's markers (`MarkerLane.tsx`). Not a **Lane** in the sense above: it
belongs to the ruler family — it measures time, windowing the same row pixels on
the same quantised scroll offset the ticks use — where a lane holds a track's
layers. Its space is held unconditionally, and the reason is sharper than the
drop strip's: `markers_visible` governs what the row PAINTS and never whether it
exists, because `M` force-enables that flag and a row bound to it would reflow
the timeline under the pointer on every press. Collapsing it is the one thing
that changes its height, and a user asks for that one. Not a scrub surface — the
ruler is the sole one, and it stayed sole by giving markers up entirely.
UI word: the row's header reads Markers / 标记; the row itself is the marker
lane / 标记轨.
_Avoid_: marker track (there is no track), ruler markers (they do not live
there), marker strip (strip is the drop strip's word), timeline marker (that
names a free marker, not the row)

**Drop strip**:
The permanently reserved row above the topmost lane that turns a drag into a new
track. Its space is held even when idle so a drag never reflows the timeline.
Idle it is a dashed rule along the bottom of that row, with a plus in the header
half — a seam, not a lane — and it lights up only while a drag is live so it
never reads as an empty lane to manage.
_Avoid_: add-track row, new-track button, ghost lane, phantom track

**Marquee**:
A rectangle dragged from a blank surface in the timeline. The surface the drag
STARTED on decides what the box selects — a lane, the drop strip or the scroll
body selects clips, a keyframe sub-lane row selects keyframes — never the box's
extent and never a modifier key (ADR 0051). A press too short to become a box is
the background click, and it clears the same population the box would have taken.
_Avoid_: lasso (it is not a freeform lasso), box select, rubber band, drag-select

**Raise**:
Moving a clip onto a fresh track at the top of the z-stack —
`move_layers_to_new_track`, reachable by dragging into the drop strip or by the
*Move to a new track* command. The spawn-at-top gesture, and only that —
anchored reordering is *Restack*. A raise may also name a landing time, and the
drag does while the command does not; without one every clip keeps the moment it
was already at. Each raise empties its source track, which cleanup then removes.
One history entry, so one undo restores clip and track together.
_Avoid_: add track and move, promote, bring to front, reorder tracks, restack

**Restack**:
Anchored z-reorder of one visual layer — `restack_layer(layer, above|below
anchor)`, the verb behind the Playhead Panel's stack ordering and the MCP command
of the same name. Operates on the layer, not its container: a sole occupant
carries its whole track, a layer sharing its track splits onto a fresh one, and
a role-stamped source never moves. Anchors are layers, never indices; audio
neither moves nor anchors. The op's exact contract lives in data-model.md.
_Avoid_: raise (that is spawn-at-top), reorder tracks, move above/below

**Playhead Panel**:
The A/B Roll context Panel, which takes its name from the origin everything in
it is measured against. Its two sections name the distance from that origin:
*Now playing* is the stack composited under the playhead — the only section
that restacks — and *Nearby* is the rest of the ±Δ window, each row carrying
its signed offset. Δ is the user's to set, from the dial in the Panel's own
toolbar (`delta_window_us`, app-level); the Panel prints no title, because the
dock tab is the title. The default layout gives it an area of its own above the
inspector rather than a tab behind it: A/B Roll is the editing model the app
defaults to, and *Now playing* is where that model is read from, so a user who
never finds the tab never learns the model. The code calls the Panel `playhead`
throughout — the `playhead` kind id, `PlayheadPanel.tsx`, `playheadItems.ts`,
the `.playhead-*` classes and the `playhead_panel` i18n namespace — so *Nearby*
now names one section and nothing else. ADR 0044 predates that rename and still
calls the Panel Nearby, because a decision record records what was decided.
_Avoid_: Nearby Panel, peek Panel, near-playhead Panel, playhead (bare — that is
the transport position, not the Panel)

**Spawn**:
The placement verdict meaning *no track can take this, so make one* — the fourth
`PlacementValidity`, alongside valid, collision and locked. Ranked below
collision, so a selection that would overlap itself on the one new track still
refuses.
_Avoid_: auto-create, insert track, overflow

## Markers

**Free marker**:
A marker with no anchor (`anchor: null`). It marks a composition's own time and
behaves in every respect as every marker did before anchoring existed: it stays
where it was put, it stays in its composition when the clips under it move,
leave or are deleted, and no edit re-times it. The default, and the right shape
for a note about the film — a music change, a chapter start.
_Avoid_: sequence marker, timeline marker (both name the composition, not this
kind), unanchored, plain marker

**Anchored marker**:
A marker carrying `{ layer, src_us }` — a layer of its own composition plus a
time in that layer's SOURCE domain. Its `t_us` is derived from that layer's
source window on every commit, so it follows the clip through moves, trims,
splits and a crossing into another composition; deleting the clip takes the
marker with it. The anchor is truth and `t_us` is a stored cache of it, which is
why every marker reader is unchanged. Not a second kind of marker — one field on
the one marker. UI word: Anchored / 已锚定.
_Avoid_: clip marker (implies a second entity beside this one — the thing this
design exists to not build), source marker, attached marker, pinned marker; and
do not read it as the tab **Anchor**, which is a different word for the
`CompositionRef` a timeline was entered through

**Hibernating**:
An anchored marker whose `src_us` has fallen outside its layer's
`[src_in_us, src_out_us)` window — the clip no longer shows the frame it names,
usually because a trim or a split moved the window edge past it. Retained in
state, not painted on the lane, and revived on the exact frame it always named
the moment the window covers it again. A derived condition recomputed every
commit, never a stored flag. UI word: Hibernating / 休眠中.
_Avoid_: lost, deleted, orphaned, broken, dangling (it is none of these — it is
asleep, and re-extending or undoing wakes it)

**Detach / attach**:
The explicit operations that clear and set a marker's anchor: detach turns an
anchored marker into an ordinary free marker at the time it currently sits on;
attach ties a free marker to the clip under it. Never implicit — no gesture,
patch or edit silently changes an anchor, because a silently-changed anchor is a
marker that means something other than what the user wrote. UI word: Attach to
clip / 锚定到片段, Detach / 解除锚定.
_Avoid_: orphan (a detached marker is an ordinary free marker, not a casualty);
unlink, unpin, release; link (that is the propagation relationship between
layers)

## Shots

**Shot**:
The span of one SOURCE between two accepted boundaries, in source-absolute
time. A shot report belongs to a source; every apply step (split, mark) belongs
to a layer, and the layer's source window is what maps one onto the other. UI
word: Shot / 镜头.
_Avoid_: scene (several shots; ffmpeg's filter is named `scene` but what it
detects is a shot change), segment (a layer a split produced), clip (a layer)

**Candidate cut**:
One `cut_scores` entry — a source time at which the frame-change score exceeded
the floor, together with that score. A measurement, not a decision: which
candidates become boundaries is what a threshold decides. A candidate the
threshold accepts is a **shot cut**; UI word: shot cut / 镜头切点 ("Mark shot
cuts" / 标记镜头切点 is the verb that writes them as anchored markers).
_Avoid_: cut (an edit), scene change, keyframe (`keyframe_t_us` is a shot's
cover-frame time, a different thing), score (the number, not the candidate)

**Floor scan**:
The one whole-source detection pass per source, run at `FLOOR_SENSITIVITY`
(0.05), timing only, and cached. It costs the same as a scan at any other
threshold, so every threshold at or above the floor is derivable from it
without another decode, and nothing below it is ever offered. The media pool's
"Analyze shots" / 分析镜头 warms it. ADR 0057.
_Avoid_: analysis (the agent's `analyze_clip` report is a different,
stats-bearing report with its own cache entry), rescan, full scan

**Reduce**:
The pure Rust re-derivation of a shot list from a floor scan at a threshold and
a minimum shot length, viewed through a window. Free — no decode, no file — and
never re-implemented in TypeScript. Stats and flags carry onto a reduced shot
only when the scan measured that exact span; otherwise they are absent, and
absent renders as absent, never as zero.
_Avoid_: filter, re-detect, refine; "reduce" is the word in code and prose alike

**Canonical cut list**:
The one list of source boundaries an apply verb consumes — either the
detector's at given or default parameters, or a list a person reviewed — and
the only path a boundary takes onto the timeline (mapped, frame-snapped,
deduplicated once). A split and a mark of the same list land on identical
frames because there is one list, not because two call sites agree.
_Avoid_: cut points (in prose; the zh UI word 切点 is fine), split points,
detected cuts (the list may be the user's, not the detector's)

**Threshold**:
The score a candidate must exceed to become a boundary. On the wire and on disk
the field is `sensitivity`, a name that reads backwards — a higher value yields
FEWER cuts — so no control is labelled with it: the human control is a line
over the candidates, and its meaning is its position.
_Avoid_: sensitivity in UI copy, detection strength, granularity (that is the
minimum shot length, a different knob that fixes a different error)

## Links and Groups

**Link**:
A flat set of two or more layers in one composition whose structural edits —
move, trim, split — fan out to every member (`Link` in `Project.links`; no
nesting, a layer in at most one). Premiere's Link with any number of members:
it says "these travel together" and nothing more — no bounds, no timeline of
its own, no rendering significance, no identity beyond an accent hue. `Ctrl+L`
toggles it on the selection. UI word: Link / 链接.
_Avoid_: group (that is a composition placed as a layer), bundle, pair (a link
may hold more than two)

**Group**:
A composition placed as one layer in another composition — After Effects'
precomp, Premiere's nest, Resolve's compound clip. It says "this is one
thing": it has bounds, a duration and a timeline Panel of its own — entering it
opens a tab beside the film's timeline rather than replacing it — and it
renders. The word is reserved for exactly this and is never a synonym for a
link. UI word: Group / 组.
_Avoid_: group for the propagation relationship (that is a link); nest,
compound, precomp in UI copy

**Composition**:
A timeline — settings, tracks, markers, transitions and links. The root is
one and every Group is one, with the same shape: there is no "sub" type,
so every walk, mutation and validator has one path. Opened, it takes a timeline
Panel of its own, addressed by its id, so several stand open at once and the
editor is never looking at exactly one. A model word with no UI word: nothing
on screen calls a composition one. A Group is "Group / 组", the root is "the
timeline", and where a gesture crosses between them the destinations name
themselves — so *Move to… ›* lists "Timeline" and each Group, and its flat form
(no list behind it) says *Move to timeline*.
_Avoid_: sub-composition (as a data-model term), sequence, nested timeline;
composition / 合成 anywhere in UI copy

**Root composition**:
The composition export renders and a fresh project opens on
(`Project.root_id`). Unnamed in the UI: it is the timeline.
_Avoid_: main composition, master sequence, top level (as a noun)

**Group layer**:
The layer a Group occupies in its parent's timeline — a media-bearing layer
whose source is a composition rather than a file, so trim clamping, split's
source distribution and keyframe re-basing apply to it verbatim. On screen it
is the Group clip.
_Avoid_: nested clip, comp layer, reference layer

**Pre-compose**:
The verb that turns a selection into a Group in place — After Effects' word;
Premiere says Nest and Resolve says Create Compound Clip. Reserves `Ctrl+G`
(and, with Ungroup, `Ctrl+Shift+G`), which is why linking sits on `Ctrl+L`.
UI word: Group / 编组.
_Avoid_: nest, compound, precomp (as the verb in UI copy); group (bare — that
is the noun)

**Ungroup**:
Expanding a Group layer back into its members in place — Resolve's Decompose
in Place. The inverse of Pre-compose and only that: it is not dissolving a
link. UI word: Ungroup / 解组.
_Avoid_: unlink (that dissolves a link), decompose, flatten, un-nest

**Orphan**:
A composition no Group layer references (`ref_count === 0`). Legal, and not a
leak: Ungroup and deleting the last Group clip both leave the composition
behind, so one undo brings the work back. Its card in the media pool is where
it stays visible — dimmed, tagged isolated — and the only surface that can
remove it, which is what keeps state from holding something no UI can reach
(the failure ADR 0042 refused for tracks). The pool's *show only unused* filter
is what finds that card once one name-sorted list has scattered it among the
media; the filter asks both kinds a plain question — what does nothing point at
— and is not a second name for this state. The root is never one: nothing may
reference it at all. UI word: isolated / 已孤立.
_Avoid_: dangling composition, leaked comp, garbage, unused Group (everything in
the pool is unused until it is placed; this state is the opposite, and the card
is dimmed, not a different kind of thing)

**Render target**:
The composition the Preview Panel draws: *follow focus* — the timeline holding
the keyboard, and the default — or one composition it is fixed on while the
keyboard edits somewhere else. The preview's own choice, never a property of a
tab, so the target may be a composition with no timeline open at all; that is
the whole point of fixing one. Export has no target to name: it renders the
root. UI word: What the preview shows / 预览内容.
_Avoid_: pinned comp, locked preview (that is the state, not the thing), active
composition

**Anchor**:
The `CompositionRef` a timeline tab was entered through — the Group clip that
fixes where this timeline's moment sits in the film. Root-to-local needs none;
local-to-root does, and that is the direction a scrub inside a Group travels.
Where a Group is placed more than once the two placements are two answers, and
the tab says which one it is reading against. UI word: Switch anchor / 切换锚点.
_Avoid_: path, breadcrumb, parent

**Moment**:
The single time the whole editor is at, held in root time and read in each
composition's own coordinates. One number, read many ways: a Group's read-out is
a projection of it, which is why scrubbing inside a Group moves the film, and
why a Group not on screen at the moment draws nothing to scrub. Session state,
never in the project. UI word: Current time / 当前时间.
_Avoid_: playhead (that is the line drawn for it), global time, sequence time

**Link override**:
A session toggle under which every gesture behaves as if `escape_link` were
set, so a linked clip edits alone without the link being dissolved — Reaper's
*Grouping enabled*, inverted. Session state, never in the project. UI word:
Link override / 链接覆盖.
_Avoid_: unlink mode, solo edit, temporary unlink

## Motifs

**Motif**:
A parameterized, time-varying overlay authored as a real web page — a manifest
island plus `index.html`, served over the `motif:` scheme and captured frame by
frame while the harness owns the clock (ADR 0017). Built-in, user-authored and
agent-authored Motifs are the same kind of document on the same render path;
placed, one is a `Motif` layer whose props are its entire instance state.
_Avoid_: template (that was the SVG predecessor), overlay, animation preset

**Props schema (data plane)**:
A Motif's `props_schema` — the four typed variants (string, color, number, enum)
its parameters may take. It is the *data* contract and nothing else: validation,
defaults, lenient migration, persistence, undo and agent drafting all read it,
and it carries no presentation — no label, order, grouping or widget hint.
Frozen: a control the vocabulary lacks comes from a params page, never from a
fifth variant (ADR 0045).
_Avoid_: prop types, control schema, param spec (that is one entry in it)

**Params page (UI plane)**:
The optional `params.html` a Motif ships beside its `index.html` to own its whole
props section of the property panel — labels, order, grouping, conditional rows.
The file's presence is the only enablement; there is no manifest field. It runs
in a sandboxed, offline `motif:` frame on an opaque origin and speaks five
postMessage verbs with the host (init, propsChanged, preview, commit, resize):
preview overlays the canvas only, and one commit is one undo entry however many
keys it carries (ADR 0045).
_Avoid_: params UI, custom panel, plugin UI, settings page

**Fallback form**:
The props form the host generates from a `props_schema` when the Motif ships no
params page — one row per prop in the manifest's key order, bare keys title-cased and
deliberately unlocalized, one key committed per gesture. The default path rather
than a degraded one: an agent draft or a plain Motif stays editable with zero
author effort, and the form is frozen at the four variants alongside the schema.
_Avoid_: generated panel, default form, auto form, generic props form
