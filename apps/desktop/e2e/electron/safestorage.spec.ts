import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

// The OS keyring (macOS Keychain, libsecret / KWallet on Linux) is asked for
// only when a cloud key is saved or read, never at launch: the check itself can
// put a system prompt in front of someone who has not touched a cloud model.
// So a fresh profile boots with no keyring notice on every host, and on a host
// without a keyring (headless Linux CI) the notice appears with the first save,
// which fails because nothing can encrypt the key. The keyring host's save
// round-trip is cloud-keys.spec.ts.
test('launch leaves the keyring alone; a key save without one fails and raises the notice', async () => {
  const { app, page } = await launchApp()
  try {
    await page.waitForFunction(() => typeof (window as any).api?.app?.notices === 'function')
    const keyringNoticeStands = async () =>
      ((await page.evaluate(() => (window as any).api.app.notices())) as Array<{ code: string }>)
        .some((n) => n.code === 'keyring_unavailable')

    expect(await keyringNoticeStands()).toBe(false)

    const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    test.skip(available, 'this host has a keyring; the save round-trip is cloud-keys.spec.ts')

    const saved = await page.evaluate(() =>
      (window as any).api.backend.invoke('settings_set_api_key', { provider: 'openai', key: 'sk-test-dummy' })
        .then(() => true, () => false),
    )
    expect(saved).toBe(false)
    expect(await keyringNoticeStands()).toBe(true)
  } finally {
    await app.close()
  }
})
