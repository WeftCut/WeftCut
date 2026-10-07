# UI design tokens

The single palette source is `apps/desktop/src/renderer/app.css`: shadcn
roles in `:root` / `.dark` plus a **dark-NLE semantic layer** on top.
Tailwind v4 is only the carrier — feature CSS consumes the roles as
`var(--*)`, never raw hex. Governance (Base UI + cascade contract):
[ADR 0018](adr/0018-ui-widgets-on-base-ui-with-tailwind-tokens.md).

This document is the full reference for the semantic layer. When a value
here drifts from `app.css`, `app.css` wins — update the doc in the same
commit.

## Dark-only, on purpose

WeftCut is a dark-only application: a neutral dark surround is part of an
editor's color judgment, and one theme keeps the visual QA surface of
every panel at ×1. `html.dark` is hardwired, `color-scheme: dark` is set
in `base.css`, and there is no color-theme switcher and no
`prefers-color-scheme` handling. The light values in `:root` are inert
theme-tool scaffolding, not a supported theme — never consume them as if
a light mode existed (decision: ADR 0018).

## Surfaces

| Token | Value | Use |
|---|---|---|
| `--background` | `#0c0e12` | App workspace. |
| `--card` | `#111419` | Panels, cards. |
| `--popover` | `#1c2028` | Floating overlays. |
| `--surface-sunken` | `#08090b` | Recessed wells: thumbnail slots, code wells, inset editors. |
| `--surface-raised` | `#181c23` | Rows/cards lifted above a panel; hover rests. |
| `--track-lane` | `#14171d` | Timeline track lane — one step above `--background` so row seams read. |
| `#000` (literal) | — | Reserved for the preview canvas and video surfaces, where color judgment matters. Never use for panel chrome. |

Structural hairlines use `--border-soft` (`#252a34`), control outlines
`--border` (`#363e4b`).

## Selection & focus

`--ring` (`#3b82f6`) is the one true accent; blue is reserved for
selection/focus.

| Token | Value | Use |
|---|---|---|
| `--selection` | `var(--ring)` | Selected outlines, active indicators. |
| `--selection-bg` | blue @ 16% | Selected backgrounds. |
| `--selection-border` | blue @ 50% | Selected borders. |
| `--focus-ring` | 2px ring, 50% mix | `box-shadow` value for `:focus-visible`. |

## Status hues

Shared feedback colors. Translucent badge/banner fills derive from these
via `color-mix(in srgb, var(--X) NN%, transparent)` instead of repeating
the hue as an rgba literal.

| Token | Value | Use |
|---|---|---|
| `--destructive` | `#f87171` | The single error role (bake errors, remove hovers, error pills/cards). |
| `--success` | `#46c46a` | Ready/ok states (bake-ready, meter green). |
| `--warning` | `#f0a020` | Warming/attention states (bake-warming, meter amber). |
| `--keyframe` | `#facc15` | Keyframe diamonds, armed stopwatches, pending badges. A domain accent, deliberately distinct from `--warning`. |

One-off categorical palettes (log category pills, kind badges, motif card
status badges) may stay literal or use the pinned `--color-*` Tailwind
shades; promote to a role only when the same hue repeats across files.

## Neutral overlays

Translucent white layers for states on otherwise-transparent controls.

| Token | Alpha | Use |
|---|---|---|
| `--surface-tint` | 0.04 | Faintest lift: quiet row hovers, inset wells, hairline seams. |
| `--hover-neutral` | 0.06 | Default hover. |
| `--hover-neutral-strong` | 0.10 | Strong hover / highlighted menu item. |
| `--active-neutral` | 0.16 | Pressed state. |
| `--border-on-dark` | 0.15 | Strokes on near-black / monitor surfaces where solid `--border` reads too strong. |
| `--border-on-dark-strong` | 0.30 | Hover step of the above. |

Deliberate exceptions that stay literal: the focused/unfocused
window-frame hairline (0.10/0.08 — OS-adjacent chrome, see `base.css`)
and the bright bake-spinner arc (0.85).

## Elevation

Three shadow levels for floating chrome. On near-black surfaces the 1px
`--border` every floating surface already carries does most of the
separation work; the shadow only lifts, so blurs stay tight.

| Token | Value | Use |
|---|---|---|
| `--shadow-menu` | `0 4px 16px`, black @ 35% | Dropdowns, context menus, small popups, editor tooltips. |
| `--shadow-popover` | `0 8px 28px`, black @ 45% | Floating panels: command palette, export/status panels, drag previews. |
| `--shadow-modal` | `0 16px 48px`, black @ 55% | Every modal dialog: settings, motif picker, connect agent, the compact form prompts (new project, rename, checkpoint). |

Directional exception: the log drawer opens from the bottom edge and casts
upward — it keeps a literal `0 -8px 28px` matched to `--shadow-popover`.

## Motion

| Token | Value | Use |
|---|---|---|
| `--transition-fast` | `90ms ease-out` | Hover/focus/color/opacity feedback. |
| `--transition-base` | `150ms ease-out` | Slower ambient changes (scrollbar thumb). |

Continuous data-driven transitions (meter/progress `width` updates) stay
`Nms linear` literals, and choreographed keyframe animations (drag-preview
morph, splash) keep their own timing.

## Radius

| Token | Value | Use |
|---|---|---|
| `--radius-control` | 4px | Inputs, buttons, badges. |
| `--radius-card` | 6px | Cards, thumbnails. |
| `--radius-panel` | 8px | Panels, dialogs. |

Pills stay literal `999px`. These are separate from shadcn's
`--radius-sm/md/lg` ramp so consuming a token never rescales a control.

## Type scale

Sizing is owned by `apps/desktop/src/renderer/styles/layout-theme.css`.
The values below describe the unchanged 1080p standard baseline; the selected
layout theme scales every role, including inherited and rem-based UI text.
Timeline ruler labels, track and clip names, markers, keyframe labels and drag
feedback consume these same roles. Ruler label spacing follows the text scale;
the frame grid and time-to-pixel mapping do not. Marker rows grow with their text,
and clip labels adapt to the space available in the user's track height.

`components/ui/button.tsx` is the shared action button. Default/large buttons
use the body role; small/extra-small buttons use caption. Use it for ordinary
actions. Navigation tabs, shortcut chips and editor gesture targets can keep
their specialized markup, but their styles must consume shared font roles too.
`settings/uiTypography.test.ts` scans application sources for fixed pixel fonts;
only authored render content and standalone developer pages are exempt. The
isolated desktop color picker receives the selected theme in its capture snapshot
so its hints and readouts follow the same roles without access to editor IPC.

| Token | Baseline | Use |
|---|---|---|
| `--font-size-micro` | 10px | Dense instrumentation: rulers, badges, kbd hints, monospace ids. |
| `--font-size-caption` | 11px | Captions, secondary metadata. |
| `--font-size-body` | 12px | Default UI text. |
| `--font-size-label` | 13px | Section labels, emphasized rows. |
| `--font-size-title` | 14px | Panel titles. |
| `--font-size-fine` | 9px | Fine print. |
| `--font-size-heading` | 16px | Larger headings and inherited root text. |
| `--font-size-display` | 22px | Splash and performance readouts. |
| `--font-size-hero` | 28px | Startup heading. |
| `--line-height-tight` / `--line-height-body` | 1.2 / 1.4 | Line-height roles. |

## Layout themes

Settings → General → Layout theme exposes one preset selector. Only
`app_settings.layout_theme` is persisted; font size, scale and window dimensions
are internal values, not individual preferences. Old or unknown saved values
fall back to `1080p-standard`; invalid writes are rejected.

Recipes live in `apps/desktop/src/shared/layout-theme.ts`:

| Theme | Text scale | Dialog width scale | Initial window (DIPs) |
|---|---|---|---|
| 1080p standard | 1 | 1 | 1440 × 900 |
| 1080p relaxed | 1.1 | 1.25 | 1760 × 900 |
| 2K (1440p) standard | 1.2 | 1.2 | 1920 × 1200 |
| 2K (1440p) relaxed | 1.32 | 1.5 | 2360 × 1200 |
| 4K standard | 1.5 | 1.5 | 2560 × 1600 |
| 4K relaxed | 1.65 | 1.875 | 3360 × 1600 |

Relaxed variants use 10% larger text than the corresponding Standard preset.

UI geometry follows the text scale through `--ui-px`: control sizes, padding,
gaps, fixed columns and minimum/maximum content widths all use baseline pixels
multiplied by this unit. Dialog width roles retain the separate width scale to
provide the additional horizontal room in Relaxed presets. Container breakpoints
use rem units so their compact layouts switch at the same effective UI width.

JS-owned dimensions use `useUiScale()` / `uiPixels()` from
`renderer/settings/layoutTheme.ts`. Dock group floors refresh after theme changes,
layout restoration and resizing; the Quick Actions strip updates both its floor
and cap. Small viewports reduce group floors toward baseline sizes to preserve
usable scrolling. Agent record and log-console drag sizes are remembered in
baseline units. Mixer breakpoints and tab overflow geometry use the same scale
as their CSS. Keep native window chrome, editing coordinates, borders and shadows
outside this conversion; do not apply a global zoom to the canvas or timeline.

The names are user-selected density presets, not automatic physical-resolution
detection. CSS pixels / Electron DIPs already include OS scaling; do not apply
`devicePixelRatio` again. Root tokens update on initial settings hydration and
every committed settings snapshot, including portal dialogs and other windows.

`styles/layout-theme.css` owns the role-based dialog widths, settings height,
model-dialog height, settings navigation width, picker column width and header
search-entry width (160px baseline, following the text scale). Feature
styles consume these tokens while retaining viewport clamps and body scrolling.
The settings dialog retains its existing 80% viewport height. New dialog skins
must use these roles rather than a new fixed pixel width.

Initial main-window dimensions are capped to the logical work area and used
only when saved geometry is unavailable or unusable. Native minimum dimensions
also follow the preset: 960 × width scale by 640 × text scale, rounded to DIPs
and capped to the current display's work area. Startup, theme switches and display
changes apply these limits. Windows below the new minimum grow to fit; switching
to a smaller preset does not shrink an existing window. The user's Dock
arrangement is retained. Authored
Text layers, composition dimensions, preview rendering and exports are outside
the layout-theme scope. The dark color palette remains unchanged.

## Shared dropdown chrome

`.app-menu-list` / `.app-menu-item` (+ `-check` / `-label` /
`-accelerator`) in `styles/menu.css` skin every dropdown alike — menu bar,
`AppSelect` popups, timeline context menus. New popups reuse these classes
instead of rolling their own list chrome.

## Media-kind colors

Timeline clip colors per media kind live in
`src/renderer/timeline/layerTheme.ts` (semantic-by-kind; `Color` layers
use the project color hint) — not in the CSS token layer.
