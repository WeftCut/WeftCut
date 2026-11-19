// Hands one shared texture to a renderer document: imports it in main and
// sends it with its tag, which the preload's `SlotReader` keys it by. GPU
// preview sessions and the Motif GPU transport both hand their textures over
// here (docs/preview.md § The Standard engine).

import { sharedTexture } from 'electron'
import type { ColorSpace, SharedTextureImported, WebFrameMain } from 'electron'
import type { SlotTag } from '../../shared/frameCarrier/wire'

/** One producer texture: its NT handle in the addon's wire bytes, its size and
 * its byte order. */
export interface SlotTexture {
  handle: Buffer
  width: number
  height: number
  format: 'rgba' | 'bgra'
}

/// The colour tag of every slot texture. The producers already wrote
/// working-space RGBA (the native NV12→RGBA shader for video, the Motif
/// renderer's own pixels), so the browser must treat the bytes as plain sRGB
/// and do no colour math of its own: this tag is what makes the preload's
/// `createImageBitmap` a byte copy. This constant and the native shader
/// constants together are the hardware lane's colour contract.
const SRGB_PASSTHROUGH: ColorSpace = {
  primaries: 'bt709',
  transfer: 'srgb',
  matrix: 'rgb',
  range: 'full',
}

/** Imports `texture` and sends it to `frame` tagged `tag`, resolving with the
 * import once the frame has received it. `onAllReleased` runs once when no
 * process references the texture any more; when the import itself fails it
 * runs before the rejection, since no reference was ever taken. A failed send
 * releases the import before it rejects. */
export async function importAndSend(
  frame: WebFrameMain,
  texture: SlotTexture,
  tag: SlotTag,
  onAllReleased: () => void,
): Promise<SharedTextureImported> {
  const { width, height } = texture
  let imported: SharedTextureImported
  try {
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width, height },
        visibleRect: { x: 0, y: 0, width, height },
        pixelFormat: texture.format,
        colorSpace: SRGB_PASSTHROUGH,
        timestamp: 0,
        handle: { ntHandle: texture.handle },
      },
      allReferencesReleased: onAllReleased,
    })
  } catch (error) {
    onAllReleased()
    throw error
  }
  try {
    // The tag rides as the receiver's extra argument, so a texture is keyed by
    // its own tag whatever order textures and sessions arrive in. The send has
    // its own timeout (about a second) and can reject.
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, tag)
  } catch (error) {
    try { imported.release() }
    catch (releaseError) { console.warn('[main] shared texture release failed', releaseError) }
    throw error
  }
  return imported
}
