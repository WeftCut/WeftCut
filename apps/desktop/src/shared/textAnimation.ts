// apps/desktop/src/shared/textAnimation.ts
//
// What a Text layer's `intro` / `outro` preset does at a given time — the one
// definition the preview and the export bake both play (they share the
// renderer's composition walk). A preset is semantic, not keyframes: it stays
// attached to the layer's own start and end, so trimming or moving the layer
// keeps the entrance at the head and the exit at the tail.
//
// The presets existed in the data model long before anything played them;
// ADR 0127 gives them their motion.

export type TextIntro = 'FadeIn' | 'SlideUp' | 'SlideDown' | 'Typewriter'
export type TextOutro = 'FadeOut' | 'SlideUp' | 'SlideDown'
export const TEXT_INTROS: readonly TextIntro[] = ['FadeIn', 'SlideUp', 'SlideDown', 'Typewriter']
export const TEXT_OUTROS: readonly TextOutro[] = ['FadeOut', 'SlideUp', 'SlideDown']

/** An entrance or exit runs this long, or a third of the layer if that is
 *  shorter, so a short layer still spends most of its time readable. */
export const TEXT_ANIM_US = 400_000
/** A slide travels half the font size. */
const SLIDE_EM = 0.5
/** Typewriter reveals a character per 40 ms, over at most half the layer. */
const TYPE_US_PER_CHAR = 40_000

export interface TextAnimationFrame {
  /** Multiplies the layer's own opacity. */
  opacity: number
  /** Added to the layer's y, composition px (positive is down). */
  dy: number
  /** How many characters show, or null for all of them. */
  visibleChars: number | null
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const easeOut = (x: number) => 1 - (1 - x) ** 3

export function textAnimationAt(intro: string | null | undefined, outro: string | null | undefined, tUs: number, durUs: number, fontSizePx: number, chars: number): TextAnimationFrame {
  const frame: TextAnimationFrame = { opacity: 1, dy: 0, visibleChars: null }
  if (!(durUs > 0)) return frame
  const span = Math.min(TEXT_ANIM_US, durUs / 3)
  const travel = SLIDE_EM * fontSizePx
  if (intro) {
    if (intro === 'Typewriter') {
      const reveal = Math.min(chars * TYPE_US_PER_CHAR, durUs / 2)
      if (reveal > 0 && tUs < reveal) frame.visibleChars = Math.ceil(chars * clamp01(tUs / reveal))
    } else {
      const p = easeOut(clamp01(tUs / span))
      frame.opacity *= p
      if (intro === 'SlideUp') frame.dy += (1 - p) * travel
      else if (intro === 'SlideDown') frame.dy -= (1 - p) * travel
    }
  }
  if (outro === 'FadeOut' || outro === 'SlideUp' || outro === 'SlideDown') {
    const q = easeOut(clamp01((durUs - tUs) / span))
    frame.opacity *= q
    if (outro === 'SlideUp') frame.dy -= (1 - q) * travel
    else if (outro === 'SlideDown') frame.dy += (1 - q) * travel
  }
  return frame
}
