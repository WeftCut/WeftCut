import type { ElectronApplication } from '@playwright/test'

/** A native D3D11 device alone is insufficient: Chromium must also be able to
 * import its shared images. Hosted Windows runners may expose a native device
 * while Chromium uses software compositing (ADR 0078's CPU fallback). */
export async function supportsMotifSharedTextures(app: ElectronApplication): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const supported = await app.evaluate(async ({ app }) => {
    // `basic` can return startup defaults before the GPU process initializes.
    const info = await app.getGPUInfo('complete') as {
      auxAttributes?: { supportsD3dSharedImages?: boolean }
    }
    return info.auxAttributes?.supportsD3dSharedImages
  })
  // An API/schema change must fail visibly, not silently skip GPU coverage.
  if (typeof supported !== 'boolean') throw new Error('Chromium did not report supportsD3dSharedImages')
  console.log(`[motif-gpu] Chromium D3D shared images: ${supported}`)
  return supported
}
