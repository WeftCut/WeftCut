import { CanvasTextGenerator } from 'pixi.js'
import { TextSprite } from '../../src/renderer/render/sprite/TextSprite'
import type { ResolvedTextView } from '../../src/renderer/render/resolveView'

// Real Canvas2D pixels, because style assertions cannot catch the black source
// glyphs leaking from Pixi's off-canvas shadow pass at reduced resolutions.
export function runTextShadowProbe() {
  const sprite = new TextSprite({ layerId: 'synthetic-title', snapToPixels: true })
  const view: ResolvedTextView = {
    content: 'Sample video title', font_family: 'Arial', font_size_px: 80,
    weight: 500, italic: false, align: 'Center', color: { r: 255, g: 255, b: 255, a: 255 },
    x: 0, y: 0, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
    outline: null, shadow: { color: { r: 0, g: 0, b: 0, a: 150 }, offset_x: 0, offset_y: 4, blur: 10 },
    box_w: 1400, box_h: 140, valign: 'Middle', line_height: 0, letter_spacing: 0,
  }
  try {
    return [true, false, true].flatMap((shadowEnabled) => {
      sprite.update({ ...view, shadow: shadowEnabled ? view.shadow : null })
      return [0.25, 0.4, 0.75, 1].map((rendererResolution) => {
        const { canvasAndContext, frame } = CanvasTextGenerator.getCanvasAndContext({
          text: sprite.text.text, style: sprite.text.style,
          resolution: sprite.text.resolution ?? rendererResolution,
        })
        try {
          const data = canvasAndContext.context.getImageData(0, 0, frame.width, frame.height).data
          let opaqueBlack = 0
          let white = 0
          let softShadow = 0
          for (let i = 0; i < data.length; i += 4) {
            const dark = data[i]! < 20 && data[i + 1]! < 20 && data[i + 2]! < 20
            if (dark && data[i + 3]! > 220) opaqueBlack++
            if (dark && data[i + 3]! > 5 && data[i + 3]! <= 150) softShadow++
            if (data[i]! > 240 && data[i + 1]! > 240 && data[i + 2]! > 240 && data[i + 3]! > 220) white++
          }
          return { shadowEnabled, rendererResolution, opaqueBlack, white, softShadow }
        } finally {
          CanvasTextGenerator.returnCanvasAndContext(canvasAndContext)
        }
      })
    })
  } finally { sprite.dispose() }
}
