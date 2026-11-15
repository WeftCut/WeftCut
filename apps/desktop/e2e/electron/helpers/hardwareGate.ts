import { test, type Page, type ElectronApplication } from '@playwright/test'
import { verifyHardwareEvidence, hardwareRequired, windowsSoftwareOnly, linuxHardwareAbsent } from '../../lib/hardware-evidence.mjs'
import { resourceDiagnostics } from './resourceDiagnostics'

/** NVDEC can be compiled into a GPU-less Linux build. A successful device
 * inventory with no NVIDIA adapter is affirmative environmental evidence;
 * a missing driver or failed inventory on a GPU host is not. */
export async function hardwareEnvironmentGate(app: ElectronApplication, page: Page, lane: string, codec: string, auto = false) {
  if (process.platform === 'win32' && lane === 'd3d11va') {
    const info = await app.evaluate(async ({ app }) => app.getGPUInfo('basic'))
    await test.info().attach('hardware-inventory', { body: JSON.stringify(info), contentType: 'application/json' })
    if (!windowsSoftwareOnly(info)) return
    if (hardwareRequired(lane, codec, process.platform, process.env.WEFTCUT_REQUIRE_HW_VARIANTS))
      throw new Error('Required D3D11VA hardware missing: inventory contains only Microsoft software adapters')
    test.skip(true, 'Verified Windows inventory contains only Microsoft software adapters')
  }
  if (process.platform !== 'linux' || lane !== 'nvdec') return
  const hardware = (await page.evaluate(() => window.api.performanceResources.info())).hardware
  // Attached on both outcomes: a run that should have skipped needs the inventory that kept it from skipping.
  await test.info().attach('hardware-inventory', { body: JSON.stringify(hardware), contentType: 'application/json' })
  if (!linuxHardwareAbsent(hardware, auto)) return
  if (hardwareRequired(lane, codec, process.platform, process.env.WEFTCUT_REQUIRE_HW_VARIANTS)
      || (auto && hardwareRequired('vaapi', codec, process.platform, process.env.WEFTCUT_REQUIRE_HW_VARIANTS)))
    throw new Error('Required NVDEC hardware missing: inventory contains no NVIDIA adapter')
  test.skip(true, auto ? 'Verified Linux inventory contains no NVIDIA adapter or VAAPI render node'
    : 'Verified Linux hardware inventory contains no NVIDIA adapter')
}

export async function hardwareGate(page: Page, layerId: string, lane: string, codec: string, before?: any) {
  const current = await page.evaluate(id => (window as any).__weftcutTest.activeClipProbe(id), layerId)
  if (current?.hwDiagnostic?.kind === 'failed') {
    const resources = await resourceDiagnostics(page)
    await test.info().attach('hardware-failure-resources', { body: JSON.stringify(resources), contentType: 'application/json' })
    console.warn('[hardware-gate] failure resources:', JSON.stringify(resources))
  }
  await test.info().attach(before ? 'hardware-after-sampling' : 'hardware-before-sampling', {
    body: JSON.stringify(current), contentType: 'application/json',
  })
  const reason = verifyHardwareEvidence(current, lane, {
    required: hardwareRequired(lane, codec, process.platform, process.env.WEFTCUT_REQUIRE_HW_VARIANTS), before,
  })
  test.skip(reason !== null, reason ?? '')
  return current
}
