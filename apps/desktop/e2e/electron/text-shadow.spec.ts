import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { launchApp } from './helpers/driver'
import type { runTextShadowProbe } from '../fixtures/text-shadow-probe'

test('reduced-resolution text has a soft shadow without a second opaque black line', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/text-shadow-probe.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', platform: 'browser',
    globalName: '__textShadowProbe', logLevel: 'silent',
  })
  const { app, page } = await launchApp()
  try {
    // Fresh source in the real Electron Canvas2D realm; no project mutation.
    await page.evaluate(outputFiles[0]!.text)
    const results = await page.evaluate(() => (
      window as unknown as { __textShadowProbe: { runTextShadowProbe: typeof runTextShadowProbe } }
    ).__textShadowProbe.runTextShadowProbe())
    for (const result of results) {
      expect(result.opaqueBlack, JSON.stringify(result)).toBe(0)
      expect(result.white).toBeGreaterThan(0)
      if (result.shadowEnabled) expect(result.softShadow).toBeGreaterThan(0)
      else expect(result.softShadow).toBe(0)
    }
  } finally { await app.close() }
})
