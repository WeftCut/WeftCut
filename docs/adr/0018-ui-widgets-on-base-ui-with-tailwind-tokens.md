---
status: accepted
---

# UI widgets ride Base UI primitives; Tailwind v4 carries the design tokens

Date: 2026-06-10

## Context

Every widget (dialogs, menu bar, selects, sliders, tooltips, context menus) was
hand-rolled: no focus trapping, no Escape/outside-press conventions, no keyboard
navigation, no portals (popups clipped by their containers), and state-machine
bugs such as two menus open at once. Only ~12% of the stylesheet was generic
widget chrome; the rest is editor layout no library replaces. Packaged libraries
(MUI, Ant, Mantine, Chakra) would mean fighting their theme systems for a bespoke
dark skin; CSS-in-JS costs runtime in a render-loop-sensitive app and would force
a stylesheet rewrite; native `<select>`/range inputs open unstyleable OS popups.

## Decision

- **Copy-source components.** shadcn registry skeletons are vendored
  (`components.json`, `src/renderer/components/ui/`, `src/renderer/lib/utils.ts`)
  and owned; `@base-ui/react` supplies headless behavior (portal, positioning,
  focus, dismissal, aria). App wrappers (`AppDialog`, `AppSelect`, `AppSlider`,
  `CornerNotice`, `Menu`/`MenuBar`, context menus) compose Base UI parts and keep
  the app's CSS classes as their skin.
- **Tailwind v4 is the token carrier.** `src/renderer/app.css` is the entry; the
  palette lives in its `.dark` block (reference: [ui-tokens.md](../ui-tokens.md)).
- **Cascade contract.** Everything Tailwind emits is layered
  (`@layer theme/base/utilities`); the feature sheets (`styles.css` →
  `styles/*.css`) are **unlayered** and win wherever both target an element.
  Preflight shows through only where legacy CSS relied on UA defaults — pin those
  explicitly (`:root { line-height: normal }` in `styles/base.css`). Never stack a
  Tailwind utility on an element a feature rule styles; remove the rule instead.
- **Dark-only, permanently.** `html.dark` is hardwired in `index.html`,
  `color-scheme: dark` in `base.css`. An NLE's neutral surround keeps colour
  judgment honest, and a second theme doubles every panel's visual QA. The light
  values in `:root` are inert tweakcn scaffolding, never consumed. A light mode
  would be a full design pass, not a palette flip.
- New dialogs use `AppDialog` (undismissable = omit `onClose`); a component that
  consumes Escape inside a dialog must `stopPropagation()` or the dialog closes.

## Consequences

- Popups escape containers and dismissal is uniform; dropdown chrome is shared
  (`.app-menu-list` / `.app-menu-item`).
- Feature layout (timeline, media pool, panels) stays hand-written CSS.
- Automated UI driving must send real pointer streams: Base UI ignores clicks
  without `pointerdown` and synthetic hover without human-scale timing; in-page
  `PointerEvent` dispatch is the reliable hook.
