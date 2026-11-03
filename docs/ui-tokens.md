# UI design tokens

The palette lives in `apps/desktop/src/renderer/app.css` (`.dark` block): shadcn
roles plus a dark-NLE semantic layer. Feature CSS consumes roles as `var(--*)`,
never raw hex. Sizing lives in `src/renderer/styles/layout-theme.css`. If a value
here drifts from those files, the files win — fix the doc in the same commit.
Governance (Base UI, cascade contract, dark-only):
[ADR 0018](adr/0018-ui-widgets-on-base-ui-with-tailwind-tokens.md). The light
values in `:root` are inert tooling scaffolding; never consume them.

## Surfaces

| Token | Value | Use |
|---|---|---|
| `--background` | `#0c0e12` | App workspace. |
| `--card` | `#111419` | Panels, cards. |
| `--popover` | `#1c2028` | Floating overlays. |
| `--surface-sunken` | `#08090b` | Recessed wells: thumbnail slots, code wells, inset editors. |
| `--surface-raised` | `#181c23` | Rows/cards lifted above a panel; hover rests. |
| `--track-lane` | `#14171d` | Timeline lane, one step above `--background` so row seams read. |
| `--border-soft` / `--border` | `#252a34` / `#363e4b` | Structural hairlines / control outlines. |

Literal `#000` is reserved for the preview canvas and video surfaces.

## Selection & focus

`--ring` (`#3b82f6`) is the one accent; blue means selection/focus only.
`--selection` (= `--ring`), `--selection-bg` (blue 16%), `--selection-border`
(blue 50%), `--focus-ring` (2px `box-shadow` at 50% mix, for `:focus-visible`).

## Status and domain hues

Translucent fills derive via `color-mix(in srgb, var(--X) NN%, transparent)`.

| Token | Value | Use |
|---|---|---|
| `--destructive` | `#f87171` | The single error role. |
| `--success` | `#46c46a` | Ready/ok (bake-ready, meter green). |
| `--warning` | `#f0a020` | Warming/attention (meter amber). |
| `--keyframe` | `#facc15` | Keyframes, armed stopwatches; distinct from `--warning`. |
| `--tack` / `--tack-foreground` | `#2dd4bf` / `#0b1f1c` | Tacks (agent review marks) and ink on a solid tack fill. |
| `--review-added` | `#4ade80` | Review: added clips and stretches. |
| `--review-modified` | `#fbbf24` | Review: modified or moved clips, "contains changes" badges. |
| `--review-removed` | `#f87171` | Review: removed ghosts and cut marks; same hue as `--destructive`, separate role. |
| `--review-focus` | `#e2e8f0` | Review focus wash and hairline; neutral so it never reads as a change class. |
| `--review-foreground` | `#101014` | Ink on a solid review fill. |

One-off categorical palettes (log category pills, kind badges, motif status
badges) may stay literal or use the pinned `--color-*` shades; promote to a role
only when a hue repeats across files. Timeline clip colours per media kind live
in `src/renderer/timeline/layerTheme.ts` (Color layers use the project colour
hint), not in CSS tokens.

## Neutral overlays

White at alpha: `--surface-tint` 0.04 (quiet hovers, wells), `--hover-neutral`
0.06, `--hover-neutral-strong` 0.10 (highlighted menu item), `--active-neutral`
0.16 (pressed), `--border-on-dark` 0.15 / `--border-on-dark-strong` 0.30 (strokes
on near-black surfaces). Literal exceptions: the window-frame hairline in
`base.css` and the bake-spinner arc.

## Elevation, motion, radius

| Token | Value | Use |
|---|---|---|
| `--shadow-menu` | `0 4px 16px` black 35% | Dropdowns, context menus, tooltips. |
| `--shadow-popover` | `0 8px 28px` black 45% | Floating panels, drag previews. |
| `--shadow-modal` | `0 16px 48px` black 55% | Every modal dialog. |
| `--transition-fast` | `90ms ease-out` | Hover/focus/colour feedback. |
| `--transition-base` | `150ms ease-out` | Slower ambient changes. |
| `--radius-control` / `-card` / `-panel` | 4 / 6 / 8px | Inputs and badges / cards / panels and dialogs. |

The upward-casting log drawer keeps a literal `0 -8px 28px`. Data-driven
transitions (meter widths) stay `linear` literals. Pills are literal `999px`. The
radius roles are separate from shadcn's `--radius-sm/md/lg` ramp.

## Type scale

Baselines at the 1080p Standard theme; every role scales with the layout theme.

| Token | Baseline | Use |
|---|---|---|
| `--font-size-fine` | 9px | Fine print. |
| `--font-size-micro` | 10px | Rulers, badges, kbd hints, monospace ids. |
| `--font-size-caption` | 11px | Captions, secondary metadata. |
| `--font-size-body` | 12px | Default UI text. |
| `--font-size-label` | 13px | Section labels, emphasized rows. |
| `--font-size-title` | 14px | Panel titles. |
| `--font-size-heading` | 16px | Headings, inherited root text. |
| `--font-size-display` | 22px | Splash, performance readouts. |
| `--font-size-hero` | 28px | Startup heading. |
| `--line-height-tight` / `-body` | 1.2 / 1.4 | |

`components/ui/button.tsx` is the shared action button (default/large → body,
small → caption). `settings/uiTypography.test.ts` rejects fixed pixel fonts
outside authored render content and standalone developer pages.

## Layout themes

One persisted app setting, `layout_theme`; everything else is derived. Unknown
saved values read as `1080p-standard`; invalid writes are rejected. Recipes in
`src/shared/layout-theme.ts` (ids `-wide` are shown as "Relaxed"):

| Id | Text scale | Dialog width scale | Initial window (DIPs) |
|---|---|---|---|
| `1080p-standard` | 1 | 1 | 1440 × 900 |
| `1080p-wide` | 1.1 | 1.25 | 1760 × 900 |
| `2k-standard` | 1.2 | 1.2 | 1920 × 1200 |
| `2k-wide` | 1.32 | 1.5 | 2360 × 1200 |
| `4k-standard` | 1.5 | 1.5 | 2560 × 1600 |
| `4k-wide` | 1.65 | 1.875 | 3360 × 1600 |

- All sizes are CSS px / Electron DIPs, which already include OS scaling; never
  multiply by `devicePixelRatio`.
- Main passes the saved id in each window's argv so the first frame is themed;
  settings hydration then stays the authority, for every window and portal.
- Native minimum window: 960 × width scale by 640 × text scale, capped to the
  display work area, re-applied on theme and display changes. A window below the
  new minimum grows; a smaller preset never shrinks it. Remembered geometry beats
  the preset's initial size.
- Settings tags the preset suited to the current display (`recommendLayoutTheme`:
  effective height `min(h, w × 0.75)` interpolated over 1080 → 1, 1440 → 1.2,
  2160 → 1.5, nearest preset, ties to the smaller, skipping presets whose minimum
  window does not fit). Advisory only; never applied automatically.
- Out of scope: Dock arrangement, authored Text layers, composition size,
  preview rendering and export.

## Themed sizes: one entry per medium

| Medium | Entry | Rule |
|---|---|---|
| CSS | `--ui-px` and role tokens in `styles/layout-theme.css` | `calc(N * var(--ui-px))`; a length that must stay real pixels carries `/* fixed-px: <reason> */` on the same line |
| Icons | `components/AppIcon.tsx` | `<AppIcon icon={X} size="body" />`; never a pixel size |
| JS geometry | `settings/uiMetrics.ts` (`UI_METRICS`) | resolved via `layoutTheme.ts`: `uiPixels()` for boxes, constraints and hit zones; `uiScaled()` for fractional SVG geometry |

- `--ui-px` follows the text scale; dialog width roles (`--dialog-width-*`) use
  the separate width scale. Container breakpoints use rem.
- Icon roles share the text roles' baselines (`fine` 9 … `display` 22,
  `--icon-size-*`).
- A component rendering a themed JS size calls `useUiScale()`. Per-panel Dock
  floors live in `workspace/panelRegistry.ts`; small viewports relax group floors
  toward baseline.
- Track heights, agent-record width and log-console height persist in baseline
  units, so a dragged size keeps its proportion across themes.
- Never themed: composition and time-axis coordinates, render tiles, stroke
  widths, borders, shadows, native window chrome. No global zoom on canvas or
  timeline.
- `settings/uiSizing.test.ts` rejects unmarked CSS px lengths, pixel icon sizes,
  lucide glyphs rendered without `AppIcon`, and literal numbers in UI-scale
  arithmetic.

## Icons

Icons come from [lucide](https://lucide.dev/icons) (`lucide-react`, the
`*Icon`-suffixed names), drawn through `AppIcon`; colour follows `currentColor`.
Icon-only buttons carry `aria-label`; the icon is decorative. No inline `<svg>`
icons, no Unicode glyphs as icons, no second icon set. Exceptions:
`components/WindowControls.tsx` (hand-drawn 10px caption glyphs that must read as
native Windows chrome) and CSS `cursor:` data-URI SVGs (the blade cursor in
`styles/editor.css`).

## Shared dropdown chrome

`.app-menu-list` / `.app-menu-item` (+ `-check` / `-label` / `-accelerator`) in
`styles/menu.css` skin the menu bar, `AppSelect` popups and context menus. New
popups reuse them.
