# WeftCut

WeftCut is an Electron + napi-rs desktop video editor. This file is the
project's glossary: the canonical word for each domain concept, what it means,
and the words to avoid. Data shapes live in [`docs/data-model.md`](docs/data-model.md),
behavior in [`docs/features.md`](docs/features.md), decisions in [`docs/adr/`](docs/adr/).

**Model word vs UI word.** Several model words never appear in UI copy; where
they differ, the entry gives the UI word as en-US / zh-CN.

## Export

**Export preset**:
A named set of portable output parameters, available across projects. Applying
one copies its values; later preset edits do not change a project. Built-ins
are read-only; personal presets live in app settings. See [export.md](docs/export.md#export-presets).

**Export job**:
One app-session task that produces a rendered file, shared by the UI and MCP.
It holds the project edit lock while it runs; a disconnected agent can
reconnect to it.

**Finalization**:
Finishing an encoded export: muxing and publishing. A failed finalization can
be retried without re-encoding.

**Publication**:
The atomic step that makes a finished export visible at its final path. The
reported filename is the one publication used.

## Time remapping

**Time remapping**:
The relationship between a clip's local time and its content's own time: a
constant rate over the selected content range. A clip's own animation keeps its
own local time.
_Avoid_: speed effect, transform animation

**Retime**:
An edit that changes the timeline duration of a selected content range,
keeping the range and scaling the clip's own keys. Requested as a rate or a
target duration. See ADR 0092.
_Avoid_: trim (changes the range), move (changes placement)

## Decode routing

**Decode Route**:
The persisted per-source answer to where preview and export read pixels from:
Bypass, DirectExport or Proxied. Distinct from *readiness* (whether the named
file exists yet).
_Avoid_: proxy plan, proxy mode, routing flags

**Bypass**: preview and export both read the original; no proxy is made.
_Avoid_: direct, no-proxy

**DirectExport**: export reads the original, preview reads a Quick proxy.
_Avoid_: original-export

**Proxied**: preview reads a Quick proxy, export reads an Export master.
_Avoid_: full-proxy, transcoded

**Quick proxy**:
A small short-GOP scrub copy of a source; a preview source only.
_Avoid_: preview proxy, proxy (unqualified)

**Export master**:
A source-resolution copy WebCodecs can decode; an export source only.
_Avoid_: full proxy, proxy (unqualified)

**Decode engine**:
The runtime overlay that resolves, per source, an engine (Standard or Lite)
and a source (original or proxy) from the decode-engine setting, the
Capability cache and the Decode Route. Preview re-resolves each session;
export resolves once at start and never mid-run. Only the user's intent
persists, never a resolution. See ADR 0030, ADR 0033.
_Avoid_: decode route (the persisted truth), tier, preset

**Standard engine**:
The FFmpeg engine (setting `ffmpeg`); decodes any original, choosing a
hardware or software lane privately. Needs the optional native-decode component.
_Avoid_: native engine, ffmpeg lane

**Lite engine**:
The WebCodecs engine (setting `webcodecs`); the always-present floor.
_Avoid_: webcodecs lane, browser decoder

**Automatic**:
The default setting (`auto`): Standard when its component is loaded and has
not failed for the source, else Lite. A resolution rule, not an engine.
_Avoid_: auto engine

**Unsupported**:
The resolution state when the chosen engine cannot decode the chosen source.
Shown as a placeholder card with *Switch to Standard*; never a silent proxy swap.
_Avoid_: unplayable, black frame, fallback

**Capability cache**:
Machine-level probe verdicts per decode lane and format class, persisted by
main and wiped when the measuring environment (ffmpeg build, GPU/driver)
changes. A property of the machine, never of a project.
_Avoid_: session bridge, decode memo

**Session bridge** (retiring):
The per-session memo of whether WebCodecs decoded a source's original, which
the Decode engine still consults. Not the Capability cache.
_Avoid_: decode memo, probe cache

**Media actionability**:
Whether a source can be placed now, given an available source and the current
Decode engine resolution. Independent of copy and optimization progress. See [preview.md](docs/preview.md#actionability).

**Workspace copy**:
The import's copy of a source into the project's `Media/` folder. A file
already under `Media/` is recorded in place; a file the pool already holds (by
identity or bytes) is never imported twice. See ADR 0151, ADR 0153.
_Avoid_: managed media, consolidate

## Transitions

**Transition direction**:
The **motion** direction of a Wipe or Slide, never the reveal side: *Wipe
left* sweeps right-to-left; *Slide left* enters from the right. This is the
wire meaning. See ADR 0035.
_Avoid_: reveal side, wipe from, source edge

**Overlap placement**:
The default arrangement of `add_transition`: the incoming layer moves left by
the duration so both participants play exactly their trimmed ranges; the
user's cut is untouched. See ADR 0048.
_Avoid_: start-at-cut, auto-extend, silent extend fallback

**extended_us / borrowed handle**:
Per-transition µs borrowed from the outgoing tail; `0` = pure placement. The
outgoing layer's cut end is always `t_end_us − extended_us`, and removal
inverts by it. See ADR 0048.
_Avoid_: placement enum, extend flag

## Transform

**Position**:
The transform anchor's location in composition pixels (schema v4). XY and
Path animation both describe it; scale and rotation hold it fixed. See ADR 0112.
_Avoid_: top-left position

**Transform anchor**:
The normalized pivot within the source or Text box, default (0.5, 0.5).
Distinct from a tab Anchor and an anchored marker.

**Crop**:
The retained rectangle of a VideoClip, in normalized source coordinates before
the transform. Changes visibility only; null keeps the whole source. See
[features.md](docs/features.md#rectangular-video-crop).
_Avoid_: trim (time), resize (dimensions)

**Linked scale**:
A layer state (`Transform.scale_linked`) where the two scale tracks are edited
as one "Scale". Not a keyframe mode; any write that diverges the pair clears it.
_Avoid_: uniform-scale mode, scale lock

## Keyframes

**Tangent**:
One side of a key's shape, `out` or `in`, as a point in its segment's unit
square plus a mode. `in` is stored as the cubic's own control point, never
mirrored. Read only by a Spline segment. See ADR 0058.
_Avoid_: handle (the drawn thing), influence, velocity

**Auto**:
The tangent mode whose numbers are solved (clamped monotone) when the track is
written; the other mode is **Free**. Smooth in `smooth_keyframes` means set Auto.
_Avoid_: smooth as a mode, auto-bezier

**Continuity**:
Whether a key's two sides share one slope (Smooth) or not (Broken); maintained
by the authoring layer, not enforced. Meaningful only between Spline segments.
_Avoid_: tangent lock, linked handles

**Segment**:
The span between two adjacent keys, with its class stored on the LEFT key:
Spline, Hold, Linear, Elastic or Bounce. A named preset is a Spline with known
tangents, not a class.
_Avoid_: interpolation as the stored thing, easing type; a layer a split produced

**Extrapolation**:
What a track does outside its first and last key (`extrapolate { before, after }`):
Hold (default), Loop, PingPong, Offset or Continue. A single key never extrapolates.
_Avoid_: cycle as the umbrella, repeat, clamp (that is Hold)

## Text box

**Text box**:
The rectangle a Text layer lays out in (`TextParams.box_w`/`box_h`). It lays
out and never magnifies; magnification is `scale`. See ADR 0049.
_Avoid_: text frame, bounding box, text bounds (the measured glyphs)

**Resize mode**:
Auto width, Auto height or Fixed, read off which box fields are set; never stored.
_Avoid_: resize enum, auto-size flag

**Shrink-to-fit**:
Fixed's answer to overrun: the largest font size that fits, with outline,
shadow, leading and tracking scaled alike. Derived at render, floored at 8 px,
never written back.
_Avoid_: auto-fit, effective font size (the derived number)

## Track placement

**Layer**:
One placed item in a track (`Track.layers`), with a kind: video, audio, image,
text, motif, group. The model word. UI word: clip / 片段, never *layer* or 图层.
_Avoid_: layer / 图层 in UI strings; item, element, object

**Track**:
The kind-agnostic container of layers (`Project.tracks`, bottom of z-stack
first). Tracks appear and disappear around placement; the user does not
provision them. See [data-model.md](docs/data-model.md#track).
_Avoid_: channel, timeline row (that is the lane)

**Lane**:
A track's rendered row in the timeline (`TrackLane.tsx`): the presentation,
not the object. Unrelated to a decode lane.
_Avoid_: lane as a synonym for track in model prose

**Reserved skeleton**:
The role-stamped tracks every project has: A roll, B roll and their audio-role
tracks. Never removed by cleanup. A `role` is what puts a track in it.
_Avoid_: default tracks, system tracks

**Track display**:
The app-level filter over shown lanes (`display_mode`): **A/B Roll** (default,
role-stamped tracks only) or **All Tracks** / 全轨显示.
_Avoid_: Show All, AB mode

**Transient**:
`Track.transient`, meaning *not in the reserved skeleton* (`transient == (role is None)`).
It marks a track eligible for cleanup, not temporary.
_Avoid_: temporary track, scratch track

**Derived name**:
A track's display name when it stores none: from its role, else a positional
number. Computed in the renderer (`trackName.ts`), never stored.
_Avoid_: auto label, default label

**Cleanup**:
With **Automatically delete empty tracks** / 自动删除空轨道 on (default), a
transient unlocked track is removed when an edit empties it. Never a sweep.
_Avoid_: prune (the function), garbage collection

**Marker lane**:
The reserved row between the ruler and the drop strip that shows markers
(`MarkerLane.tsx`). Part of the ruler family, not a Lane; not a scrub surface.
UI word: Markers / 标记 (header), marker lane / 标记轨.
_Avoid_: marker track, ruler markers, marker strip

**Drop strip**:
The reserved row above the top lane that turns a drag into a new track. Its
space is held even when idle.
_Avoid_: add-track row, ghost lane, phantom track

**Marquee**:
A box dragged from blank timeline space. The surface it starts on decides what
it selects (clips or keyframes), never its extent or a modifier. See
[features.md](docs/features.md#timeline-selection).
_Avoid_: lasso, rubber band

**Raise**:
Moving clips onto a fresh track at the top of the z-stack
(`move_layers_to_new_track`; drop strip or *Move to a new track*). One undo.
_Avoid_: promote, bring to front, restack

**Restack**:
Anchored z-reorder of one visual layer: `restack_layer(layer, above|below anchor)`,
used by the Playhead Panel. Anchors are layer or track identities, never
indices. Contract in [data-model.md](docs/data-model.md).
_Avoid_: raise (spawn-at-top), reorder tracks

**Playhead Panel**:
The A/B Roll context Panel (kind id `playhead`). *Now playing* is the visual
stack under the playhead and the only section that restacks; *Nearby* lists
hidden clips within ±Δ (`delta_window_us`).
_Avoid_: Nearby Panel (Nearby is one section), playhead (bare: the transport position)

**Spawn**:
The `PlacementValidity` verdict *no track can take this, so make one*, beside
valid, collision and locked; ranked below collision.
_Avoid_: auto-create, overflow

**Ripple delete**:
Delete that also closes what it vacated (*Ripple delete* / 波纹删除,
`Shift+Delete`; bare `Delete` lifts). The **hole** is a deleted layer's
footprint on its own track; later layers on every track move left by the holes
ahead of them. See [features.md](docs/features.md#ripple-delete).
_Avoid_: ripple trim, implicit ripple

**Gap**:
The empty span on one track between two layer boundaries (or time 0 and a
layer). Trailing space is not a gap. Selectable; its `Delete` closes it via
ripple. UI word: Gap / 间隙; history *Closed gap* / 闭合间隙.
_Avoid_: hole (ripple's per-layer measure), blank space / 空白

## Markers

**Free marker**:
A marker with `anchor: null`: it marks the composition's own time and no edit
re-times it. The default.
_Avoid_: sequence marker, timeline marker, unanchored

**Anchored marker**:
A marker with `{ layer, src_us }`; its stored `t_us` is derived from the layer
on every commit, so it follows the clip and leaves with it. One field on the
one marker, not a second kind. UI word: Anchored / 已锚定.
_Avoid_: clip marker, pinned marker; tab **Anchor**

**Hibernating**:
An anchored marker whose `src_us` is outside its layer's source window: kept,
not painted, revived when the window covers it. Derived, never stored. UI word:
Hibernating / 休眠中.
_Avoid_: lost, orphaned, dangling

**Detach / attach**:
The explicit operations that clear and set a marker's anchor; never implicit.
UI words: Attach to clip / 锚定到片段, Detach / 解除锚定.
_Avoid_: orphan, unlink, unpin; link (that is between layers)

**Pause**:
A stretch of an Audio layer's played audio whose peak stays under the
threshold for the minimum length, read from the peaks of what plays. A
VideoClip delegates to its linked Audio. UI word: Pauses / 停顿.
See [features.md](docs/features.md#pauses).
_Avoid_: silence / 静默, 静音 (mute), gap, dead air

**Pause mark**:
An amber anchored region marker per pause, written by **Mark pauses** /
标记停顿; changes no timing. **Remove pauses** (`remove_pauses`) cuts them out.
_Avoid_: pause region as a marker kind, cut pauses (for the mark)

## Shots

**Shot**:
The span of one source between two accepted boundaries, in source time. Shot
reports belong to a source; applying (split, mark) belongs to a layer. UI word:
Shot / 镜头.
_Avoid_: scene, segment, clip

**Candidate cut**:
One `cut_scores` entry: a source time whose frame-change score exceeded the
floor. A threshold decides which become **shot cuts** / 镜头切点.
_Avoid_: cut (an edit), scene change, keyframe (`keyframe_t_us` is a cover frame)

**Floor scan**:
The one cached detection pass per source at `FLOOR_SENSITIVITY` (0.05); every
higher threshold derives from it. Warmed by *Analyze shots* / 分析镜头. See ADR 0057.
_Avoid_: analysis (`analyze_clip` is a different report), rescan

**Reduce**:
The pure Rust re-derivation of a shot list from a floor scan at a threshold and
minimum length; never re-implemented in TypeScript.
_Avoid_: filter, re-detect, refine

**Span measurement**:
The opt-in three-frame sample giving a shot span brightness, motion, sharpness
and flags; cached by span, not by detection parameters. UI word: Measure shots / 测量镜头.
_Avoid_: stats pass (in UI copy), re-measure

**Canonical cut list**:
The one list of source boundaries an apply verb consumes (detected or
reviewed), mapped and frame-snapped once, so split and mark land on the same frames.
_Avoid_: cut points, split points, detected cuts

**Threshold**:
The score a candidate must exceed. Stored as `sensitivity`, which reads
backwards (higher = fewer cuts), so no control is labelled with it.
_Avoid_: sensitivity in UI copy, granularity (minimum shot length)

## Inference models

**Model profile**:
A named speech or video-understanding model plus the configuration to run it.
Replacing weights or an endpoint makes an independent custom profile.
Credentials stay outside it.
_Avoid_: engine as the user's selection, automatic model

**Model preparation**:
Installing a profile's files and validating it with a small inference; only
success makes it current. A model is never silently replaced by another.
_Avoid_: download as a synonym for activation, silent model fallback

## Descriptions

**Description**:
What a video-understanding model said about a stretch of one source: segments
with prose and tags, cached per source, Description purpose and Description
view. Each describe call is a **run**; newer runs win where they overlap.
Read-only: never reviewed or edited. UI word: Describe clip content /
描述片段内容; none reads Not described / 未描述.
_Avoid_: caption, subtitle, transcript; scene description in UI copy (`SceneDescription` in Rust)

**Clip summary**:
Two to four sentences over a whole clip-content run longer than one request;
leads the Shots Panel's clip-content section. Cleared on re-describe. See
[mcp.md](docs/mcp.md#video-understanding-optional-user-supplied).
_Avoid_: description (the segments), synopsis

**Description view**:
The five inputs that key a cached description: engine, model, sampling rate,
focus, interface language. Changing one reads another view; nothing is deleted.
_Avoid_: default view, baseline

**Description purpose**:
What a description answers: clip content (`clip`) or individual-shot
identification (`shot`). Purposes have separate caches, jobs and progress and
never satisfy each other. See [mcp.md](docs/mcp.md#video-understanding-optional-user-supplied).

## Links and Groups

**Link**:
A flat set of two or more layers in one composition whose move, trim and split
fan out to every member (`Project.links`; a layer in at most one). No bounds,
no rendering. UI word: Link / 链接. See ADR 0052.
_Avoid_: group, bundle, pair

**Group**:
A composition placed as one layer in another (AE precomp, Premiere nest). Has
bounds, a duration and its own timeline Panel; renders. UI word: Group / 组.
_Avoid_: group for a link; nest, compound, precomp in UI copy

**Composition**:
A timeline: settings, tracks, markers, transitions, links. The root and every
Group share one shape. No UI word: the root is "the timeline", others are Groups.
_Avoid_: sub-composition, sequence, nested timeline; composition / 合成 in UI copy

**Root composition**:
The composition export renders and a project opens on (`Project.root_id`).
_Avoid_: main composition, master sequence

**Group layer**:
The layer a Group occupies in its parent; its source is a composition. On
screen: the Group clip.
_Avoid_: nested clip, comp layer

**Pre-compose**:
The verb that turns a selection into a Group in place (`Mod+G`; Ungroup is
`Mod+Shift+G`). UI word: Group / 编组.
_Avoid_: nest, compound, precomp in UI copy; group (bare: the noun)

**Ungroup**:
Expanding a Group layer back into its members in place; the inverse of
Pre-compose, not dissolving a link. UI word: Ungroup / 解组.
_Avoid_: unlink, decompose, flatten

**Orphan**:
A composition no Group layer references (`ref_count === 0`). Legal; shown
dimmed in the media pool, its only removal surface. The root is never one. UI
word: isolated / 已孤立.
_Avoid_: dangling composition, leaked comp, unused Group

**Render target**:
The composition the Preview Panel draws: *follow focus* (default) or one fixed
composition. A preview choice, not a tab property. UI word: What the preview
shows / 预览内容.
_Avoid_: pinned comp, active composition

**Anchor**:
The `CompositionRef` a timeline tab was entered through, fixing where its
moment sits in the film when a Group is placed more than once. UI word: Switch
instance / 切换实例.
_Avoid_: path, breadcrumb, parent

**Moment**:
The single editor time, held in root time and read in each composition's own
coordinates. Session state. UI word: Current time / 当前时间. See ADR 0053.
_Avoid_: playhead (the line drawn for it), global time

**Link override**:
A session toggle under which every gesture acts as if `escape_link` were set:
linked clips edit alone without unlinking. UI word: Link override / 忽略链接.
_Avoid_: unlink mode, solo edit

## Position animation

See ADR 0060.

**XY mode**: Position authored as independent X and Y animation.
_Avoid_: pathless mode, simple mode

**Path mode**: Position authored as a spatial route plus a progress animation along it.
_Avoid_: linked XY, vector keyframes

**Motion path**: The spatial route a layer's Position follows, independent of timing.
_Avoid_: trajectory (observed motion), timing curve

**Path progress**: Distance along the motion path as a fraction of its length; its animation sets timing.
_Avoid_: node index, speed

**Position baking**: Explicit conversion of motion to XY keys at chosen samples; approximate between them.
_Avoid_: lossless conversion, unlinking

**Editable position conversion**:
The default Path → XY conversion: curves fitted within a pixel-error target,
sparse keys at motion changes. Frame baking is the explicit alternative.
_Avoid_: exact conversion, one key per sample

**Spatial node mode**: Corner, Smooth or Auto handles on a path node; spatial, not temporal easing.
_Avoid_: keyframe easing, interpolation mode (unqualified)

**Shape-preserving insertion**: Adding a path node by subdividing a segment without changing the route or progress.
_Avoid_: append point, re-smoothing

## Motifs

**Motif**:
A parameterized, time-varying overlay authored as a web page (manifest island +
`index.html`), served over `motif:` and captured frame by frame under a
harness-owned clock. Placed, it is a `Motif` layer whose props are its whole
state. One Motif draws one element ([motif-authoring.md](docs/motif-authoring.md#scope-one-element-or-one-interaction)).
See [motifs.md](docs/motifs.md), ADR 0017.
_Avoid_: template, overlay, animation preset

**Motif draft**: A retained, editable package, optionally linked to a working directory.

**Motif revision**: The content hash of a complete validated package; stale writes are rejected by it.

**Installed Motif**: A published copy with its own identity and version; publishing keeps the draft.
See [motif-workspaces.md](docs/motif-workspaces.md).

**Motif preparation**:
The Workspace session's background work that persists Motif frame ranges:
used ranges when *Pre-bake motifs* is on, full content on *Pre-bake now*.
Ready = durable coverage; preview warming = volatile memory. See ADR 0108.
_Avoid_: preview-owned bake queue

**Motif cover**:
A saved image of a Motif's default appearance for the library; derived from
the package, independent of placed props.
_Avoid_: preview bake

**Motif frame reader**:
The renderer's one way to read a stored Motif frame at a scale divisor; null
means not stored or invalid, a transport failure is never null. A live capture
is not a read. See ADR 0154.
_Avoid_: frame transport, cached-frame IPC

**Props schema (data plane)**:
A Motif's `props_schema`: five typed variants (string, color, number, enum,
media). The data contract only, no presentation. See ADR 0045, ADR 0132.
_Avoid_: prop types, control schema

**Params page (UI plane)**:
An optional `params.html` beside `index.html` that owns the Motif's props
section, in a sandboxed offline frame speaking `motif:*` postMessage verbs. One
commit is one undo entry. See ADR 0045.
_Avoid_: params UI, plugin UI

**Fallback form**:
The props form the host generates from `props_schema` when there is no params
page. The default path, not a degraded one.
_Avoid_: generated panel, auto form

## Audio effects

**Source audio analysis**:
Local amplitude measurements of an imported source: waveform, onset candidates,
energy changes, in source time. Not beats or melody. Distinct from a Pause.
_Avoid_: beat detection, melody detection

**Audio effect**:
An `Effect` on an Audio layer with an `audio.*` kind, baked once offline into
a conform sibling, never evaluated per frame. Denoise is the one kind. UI
word: Effects / 效果, Denoise / 降噪. See ADR 0063.
_Avoid_: audio filter (the ffmpeg graph), insert, plugin, realtime effect

**Effective chain**:
The enabled, catalogued, complete audio effects of a layer, in order; empty
means the raw conform plays.
_Avoid_: active chain, effect stack

**Chain signature**:
The hash over media hash, conform version and effective chain that names one
bake; equal signatures share one file.
_Avoid_: effect hash, cache key, fingerprint

**Bake**:
The ffmpeg run that writes the conform sibling a chain signature names, and
that file. Preview and export both read it. UI word: Processing… / 处理中.
_Avoid_: render, freeze, bounce

**Sample region**:
The source span a user marks as noise only, so Denoise can learn from it; the
effect still applies to the whole clip. UI word: Select region / 选区.
_Avoid_: noise selection, in/out marks, noise print

## Captions and subtitles

**Subtitle**:
A subtitle document (`.srt`, `.vtt`, `.ass`) held as a `Subtitle` pool item.
Applying it (`apply_subtitles` or a drag) lays copies of its cues as Captions.
_Avoid_: subtitle for a cue on the timeline, subtitle track

**Caption**:
One cue on the timeline: an ordinary `Text` layer on a caption-role track. UI
word: caption / 字幕.
_Avoid_: subtitle, caption layer kind (there is none)

**Text correction**:
Reference-text-assisted correction and resegmentation of caption text, on new
transcripts or existing captions. Estimated word times stay marked as
estimates. UI word: Text correction / 文字校正. See [captions.md](docs/captions.md).
_Avoid_: 强制对齐 (acoustic alignment), 文稿对齐

## Performance resources

**Workspace session**:
One opening of a project, identified by a generation. Reopen, Save As and
Close end it; stale completions cannot reach a later session. See ADR 0102.
_Avoid_: cache lifetime

**Resource policy**:
App-wide intent: memory target, processing effort, temporary cache space,
background work during playback. One native authority admits work on every
platform; targets are cooperative, not OS caps. UI words: Memory target /
内存使用目标, Processing effort / 处理强度, Temporary cache space / 临时缓存空间.
See ADR 0101, ADR 0150.
_Avoid_: guaranteed RAM cap, CPU percentage cap

**Cache budget**:
The desired combined retention of video and animation pictures, thumbnails and
waveforms; active pictures may exceed it. Not the app's memory limit.
Diagnostic word: Preview cache / 预览缓存.
_Avoid_: RAM limit, total memory cap

**Shared graphics buffer budget**:
The allowance for buffers that carry pictures to preview over the shared-texture
transport. Diagnostic word: Shared texture transfer buffers / 共享纹理传输缓冲.
_Avoid_: total VRAM limit

**Performance policy**:
The legacy preview compatibility input; saved values cannot raise the app
ceiling. No UI; see ADR 0101 and
[performance-settings.md](docs/performance-settings.md#legacy-preview-budgets).

**Computer test profile**:
A saved experimental workload recommendation with its provenance. Saving does
not apply it. See [performance-settings.md](docs/performance-settings.md).
_Avoid_: hardware capacity, optimal configuration, certification

## Layout themes

**Layout theme**:
An app-wide preset of UI typography, dialog sizes and initial window size:
1080p, 2K or 4K, each Standard or Relaxed / 宽松. Not the color palette or
Dock layout. UI word: Layout theme / 布局主题. See [ui-tokens.md](docs/ui-tokens.md).
_Avoid_: zoom level, font-size setting, color theme

## Agent activity

**Agent view**:
The lightweight preview + mini timeline + agent panel layout, entered and left
independently of work. UI word: Agent Mode / 代理模式. See [mcp.md](docs/mcp.md#agent-panel-and-lifecycle).
_Avoid_: session (for the layout)

**Work session**:
One explicitly begun batch of agent work with an ID, owning MCP connection
and reason. Ending it releases its undo lock; it cancels nothing.
_Avoid_: view mode, agent permission, execution lock

**MCP connection**:
A registered protocol connection, identified independently of client name.
Transport close ends its work session; registration is not a heartbeat.
_Avoid_: online agent

**Agent activity**:
A structured record of an MCP call or checkpoint action in this opening: who,
work session, operation, state, duration, error, history IDs. Not persisted.
_Avoid_: log entry, history entry, transcript

**Tack**:
A time range an agent points the user at for review. Moves with the content it
covered; current while that range plays as it did, else outdated (内容已修改).
Runtime-only, never in the project. UI word: Tack / 批注. See ADR 0115, ADR 0117.
_Avoid_: annotation, agent marker, review marker, comment; 标注, 备注; stale or hibernating tack

**Review lane**:
The row below the marker lane that shows tacks; ruler family, not a scrub
surface. UI word: Tacks / 批注 (header), review lane / 审阅行.
_Avoid_: tack track, review track

**Review baseline**:
The project state the user last accepted, against which agent changes are
reviewed. Owned by history; reset on open, advanced only by Approve. Not a
listed checkpoint. UI word: review baseline / 审阅基线.
_Avoid_: base checkpoint, snapshot (unqualified)

**Unreviewed change**:
One entity-level difference from the review baseline that an agent commit
touched: added, removed or modified (新增 / 删除 / 修改). No causal inference
between entities. UI word: Change / 变更. See ADR 0116.
_Avoid_: diff entry, hunk, carried change; shifted / moved as classes

**Approve**:
Make the current state the review baseline, all at once (no per-change
approval). Records nothing. UI word: Approve all / 全部批准. See ADR 0115.
_Avoid_: accept, commit, apply

**Revert all**:
Restore the review baseline as one undoable user commit; the baseline stays.
UI word: Revert all / 全部撤回.
_Avoid_: reject, discard, rollback

**Review focus**:
The one tack or change the agent panel and timelines point at together; scrolls
into view, never seeks. Runtime-only.
_Avoid_: selection (clips'), highlight (per-activity)

## Agent harness

What an agent knows about how a result should look and how a job runs, in
layers: etiquette, craft, style, TASTE, recipe. See ADR 0046, ADR 0126.

**Craft**:
Brand-agnostic production rules as numbers or thresholds (title-safe, minimum
hold, fades, loudness) plus anti-patterns, in the skill's `craft/`. A style
may tighten, never loosen them.
_Avoid_: best practices, taste

**Style**:
A named look as data (fonts, palette, type scale per graphic role, caption
style, transitions, timings), packaged with its Motifs and exemplars; a
project can pin it. Never prescribes order.
_Avoid_: theme (layout theme), template, preset, brand

**Project folder**:
The folder holding `project.json`; may be an agent's working directory.
`Media/` holds pooled files, `Cache/` is derived, `TASTE.md` is hand-edited.
Relative tool paths resolve against it. See ADR 0152.
_Avoid_: project directory

**TASTE**:
`TASTE.md` in the project: extends one style and overrides its fields. Always
capitals.
_Avoid_: taste (lowercase: judgment), project style

**Style Motif**:
A Motif that carries a style's shared prop keys (`ink`, `accent`,
`font_<slot>`, ...) so placing or restyling fills them from TASTE, and leaves
through its own `exit` prop. See ADR 0126.
_Avoid_: template, theme Motif

**Recipe**:
How one kind of agent job runs: an ordered subset of the stage catalog
(intake, plan, build, audit, look, critique, handoff) with an exit condition
in the signal vocabulary (audit.clean, critique.clear, user.confirmed, rounds).
One `recipes/<name>.md` per job kind. Never names a font or colour.
_Avoid_: pipeline, workflow, skill (the whole bundle)

**Graphic role**:
What a visual layer is for (`graphic_role` on text, Motif and image layers):
title, lower_third, callout, credit, logo, plate, illustration, none, or a
custom role. Captions carry none.
_Avoid_: role (a track's role, ADR 0023), kind

**Audit**:
`check_composition`'s pass over one composition against craft and TASTE.
**Findings** have severity `hard`, `warning` or `review`. An audit is
**fresh** while the composition and TASTE are unchanged.
_Avoid_: lint, validation (the model refusing a write), review (settling changes)

**Entrance and exit**:
A Text layer's `intro` / `outro` presets (fade, slide, typewriter), played
from its own start and into its own end. A Style Motif uses its `exit` prop.
_Avoid_: transition (joins two clips), animation (keyframes)
