---
status: accepted
---

# Strip overflow is announced by a two-ended overlay, not a named list

## Context

Two surfaces in the app are single-axis strips that never wrap: the dock tab
strip (`.dv-tabs-container`, one tab per open Panel in a group) and the Quick
Actions strip (one icon button per one-click command). Both scroll when their
content outgrows the box. Each grew its own answer for saying so, and both
answers only speak about one end.

The dock strip hides its scrollbar — Dockview's is hover chrome that flashes on
every wheel tick — and leans entirely on Dockview's overflow control: a chevron
pinned to the strip's trailing end that opens a list of the clipped tabs by
name. The app invested heavily in it: a themed popover, a click-geometry
re-dispatch so the popover anchors under the button instead of the pointer,
right-alignment, arrow-key roving over the rows, a keyboard shortcut, an adapter
method, and middle-click-to-close on a row.

The Quick Actions strip took the other road: a trailing gradient mask, no
control at all.

Both share a defect the chevron cannot fix by construction. It is anchored to
one end, so once the user has scrolled, the content now hidden *behind* them is
unannounced — the strip looks, at a glance, exactly like a strip with nothing
hidden. The Quick Actions mask has the mirror flaw twice over: it is static, so
it keeps fading the trailing edge after the strip has already reached its end,
announcing content that is not there.

Three model facts shape the fix.

A tab is a Panel's **only** title: Panels never print a title inside themselves,
so whatever the tab shows is the whole of what names the thing on screen. That
makes the usual escape from a crowded strip — let the tabs shrink and ellipsize —
the expensive option here rather than the cheap one, and it means a narrowed group
starts hiding tabs early.

Tabs and quick actions are **discrete named destinations**, not continuous
content. There is no meaningful "page" of them, and a scroll offset that stops
mid-item leaves a destination the user can see but not read.

The two strips are not symmetrical. Tabs carry names and have a second,
complete way in — the View menu lists every Panel and activates an open one.
Quick actions are anonymous, uniform icons; a button the user cannot reach is a
button they cannot identify, and their fallback is the keyboard shortcut each one
already displays.

## Decision

Overflow on a strip is announced at **both** ends, by an overlay that floats
above the content, and the named list is retired.

1. **A tab never truncates its title.** The floor on a tab's width is the width
   of its own title, so the label's ellipsis rule can never fire and no Panel is
   ever named by a prefix. A name the reader has to guess at costs more than a
   strip they have to scroll: the tab is the only place that name appears, while
   the strip has an affordance for its own overflow and two other ways in
   besides. A group too narrow for its tabs hides them off the end instead, and
   saying so is the rest of this decision's job — which is therefore the common
   case, not a rare one.

2. **The affordance is a two-ended overlay: a gradient with an arrow on it.**
   Both live in the same layer and appear on an end exactly when that end still
   hides content. The gradient is the announcement, the arrow is the action, and
   the two are never out of step: an end is either fully dressed or completely
   bare. A strip that does not overflow is visually untouched.

3. **The overlay floats; it never takes layout width.** This is load-bearing,
   not cosmetic. An affordance that occupies width narrows the strip, and an
   affordance that also disappears at the end stop hands that width back — which
   can lift the strip out of overflow, which brings the affordance back. Floating
   is what makes "disappears at the end stop" safe to have at all.

4. **Random access is not the overflow control's job.** It belongs to the
   command surfaces: the View menu (every Panel, by name, activating an open one
   and scrolling its tab into view) and the search palette. The chevron, its
   popover, its keyboard shortcut, its adapter method, and its middle-click close
   are deleted rather than re-homed — Dockview's own list is switched off at the
   source (`disableTabsOverflowList`).

5. **A step is item-aligned.** Clicking an arrow scrolls until the nearest item
   that is not fully readable becomes fully readable — the leading item's start,
   or the trailing item's end, brought to the readable band's edge. Not a
   fraction of the viewport, and not CSS scroll snapping, which would fight the
   tab strip's own drag-reorder edge auto-scroll. There is no press-and-hold
   repeat: a strip holds as many items as a Group holds Panels, so the hidden set
   is a handful at worst, and repeat is a long-list affordance with no long list
   to serve.

6. **Occlusion is real, so coming to rest under an overlay is corrected.** A
   floating overlay hides the content beneath it, and the app's own paths steer
   items straight into that band: Dockview aligns a newly activated tab flush
   with the scrollport edge, which is precisely where the leading overlay sits.
   Both paths are corrected — `scroll-padding` for the browser's native
   focus scroll, and an explicit correction for the flush-align path.

7. **The arrows are pointer-only devices.** They are real buttons with accessible
   names but stay out of the tab order: the tab strip's own roving arrow keys
   already reach any tab and *activate* it, which is strictly better than
   scrolling to it. Keyboard reach does not depend on this decision at any point.

8. **The geometry is pure, and lives once.** One module owns the overflow
   predicate, the two end states, the step target, and the come-to-rest
   correction; a hook does the DOM reading and subscribing. Both strips consume
   the same module, so "which ends hide content" cannot drift between them.

## Considered options

**Keep Dockview's named list.** Rejected. Its one virtue — reaching any hidden
tab by name in one click — is already covered by the View menu, complete with
the scroll-into-view that makes it land. What it cannot do is say which
*direction* content is hidden in, which is the actual defect. Keeping it
alongside the arrows would put three controls on a 28px strip and leave two
overlapping keyboard stories to maintain.

**`::scroll-button()`.** The platform primitive for exactly this shape, and
available on the pinned engine. Rejected on placement: the pseudo-elements are
generated on the scroll container, and the dock strip's scroll container carries
`role="tablist"` — the buttons would land inside it. Its fixed
fraction-of-the-scrollport step also cannot be item-aligned. Dockview's header
exposes slots on either side of the strip, outside the tablist, which is
strictly the better mount.

**Reserve the space instead of floating: a transparent inline border.** A border
box does not scroll, so arrows sitting on it would never occlude an item, and
the come-to-rest correction (6) would be unnecessary. Rejected: at an end stop
the now-bare band reads as a stray indent on the strip's edge, and reserving the
band is what re-couples "the affordance disappears" to "the strip's width
changes" — the loop (3) exists to avoid.

**Reveal the affordance on hover.** Rejected. The defect being fixed is that a
strip with hidden content looks like one without; hover-only restates it as
"looks like one without, until you happen to point at it". Nobody hovers a strip
to audit it — they hover it to click an item, and an affordance that appears
under the pointer and takes width moves that item out from under it.

**Arrows that take width and grey out at the end stop.** The conventional
desktop answer, and it is stable. Rejected in favour of (2): an end that has
nothing to say should say nothing, and floating (3) makes that free.

**Page-dot indicators.** Rejected. Dots carry carousel semantics — equal-weight,
anonymous, discrete pages. A strip of named destinations satisfies none of the
three, and a dot count is noise next to the arrow's own presence.

## Consequences

- Closing a Panel by middle-clicking its row in the hidden-tabs list is gone.
  The remaining paths — the View menu's close item and the tab context menu —
  are unchanged, and the dock e2e spec that documented the third path changes
  with this ADR.
- The tabs-overflow keyboard shortcut is gone, and with it an entry from the
  keyboard shortcuts panel. Nothing replaces it: the tablist's arrow keys were
  always the better keyboard path, and (7) leaves them untouched. No migration
  is owed for a user who had rebound it — the overrides file is a plain
  key/value store that is only ever read through the code's own action
  catalogue, so an orphaned entry is inert.
- An overlay-sized band at each active end is unclickable, and what it covers is
  the clipped item the user might have clicked. The loss is same-direction —
  the arrow underneath the pointer does exactly what clicking the half-item
  would have started — but it is a loss.
- When the hidden extent on an end is smaller than the overlay, the overlay
  occludes more than it reveals. Accepted, and (1) makes it more common rather
  than less: full-width tabs reach overflow sooner. The floor under it is that a
  strip whose whole travel is inside the geometry's tolerance reports as fitting,
  so no overlay ever appears over content the user cannot scroll to at all.
- An end stop cannot be read exactly, which the decision has to absorb. The
  offset is fractional while the extents it is compared against — `scrollWidth`
  and `clientWidth` — are integers, so the limit derived from them can name an
  offset past the furthest the browser will ever scroll to. Both ends are
  therefore judged with a tolerance wide enough to cover that, which is what
  keeps a strip parked at its true maximum from claiming an end it has not
  reached, and its arrow from becoming a control whose every click the browser
  discards. The exact bound and its derivation live beside the constant.
- Dockview still computes its overflow set internally and still fires the
  corresponding event; with the control switched off nothing consumes either.
  Harmless, and not worth a fork to remove.
- The Quick Actions strip gets the two-ended gradient and no arrows, per the
  asymmetry in the context: its items are anonymous, so occluding one costs more
  than occluding a named tab, and every one of them already displays a keyboard
  shortcut. Its static trailing mask — which lied at the end stop — goes away.
- The two strips now agree on when an end has something to announce, because
  they read the same predicate. They deliberately disagree on what to *draw*,
  and that is the only difference between them.

## Where this lives

- The geometry — `renderer/lib/edgeOverflow.ts`: the overflow predicate, the two
  end states, the item-aligned step target, and the come-to-rest correction. Pure
  and DOM-free, with its two tolerances — one for comparing fractional layout
  numbers, one for comparing against the scroll limit — and the "an item wider
  than the readable band pins its start" invariant stated at their own sites.
- The DOM side — `renderer/hooks/useEdgeOverflow.ts`: reading the scroller,
  subscribing to scroll and resize, and handing both strips the same state.
- The dock strip — `workspace/DockWorkspace.tsx`: `disableTabsOverflowList`, the
  overlay mounted in the header slots on either side of the tablist, and the
  come-to-rest correction. `styles/workspace.css` carries the overlay's paint and
  loses the popover block.
- The no-truncate floor — `styles/workspace.css`, beside the tab's own metrics.
- The Quick Actions strip — `panels/QuickActionsPanel.tsx` and its stylesheet
  block, trading the static mask for the shared state on both axes.

## Industry baseline

Direction arrows at both ends of an overflowing strip, disabled or absent at the
end stop, is the desktop convention — Firefox's tab strip, Excel's and
LibreOffice's sheet tabs, and the scroll-button mode of most component
libraries. What those all do and this decision does not is reserve layout width
for the buttons; floating is the concession to a 28px strip where that width
comes straight out of the names.

Named overflow lists are equally conventional — VS Code's editor tabs, Premiere's
panel `»`, Photoshop's document tabs — and this decision does not reject the
capability, only its home in the overflow control. Moving it to the command
surfaces is the same trade a command palette makes everywhere else.

Shrinking tabs until they ellipsize is Chrome's and VS Code's behaviour, and this
decision declines it. Their tabs are documents named again elsewhere — a window
title, a breadcrumb, a path in the status bar — so a truncated tab costs them a
glance. A WeftCut tab is the only place its Panel is named, so the same
truncation costs the name outright, and scrolling is the cheaper trade.
