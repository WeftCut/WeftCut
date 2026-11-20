import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { launchApp } from './helpers/driver'
import type { ModelsView } from '../../src/shared/inference-models'

// The OS keyring (macOS Keychain, libsecret / KWallet on Linux) is asked for
// only when a cloud key is saved or read, never at launch: the check itself can
// put a system prompt in front of someone who has not touched a cloud model.
// So a fresh profile boots with no keyring notice on every host, and on a host
// without a keyring (headless Linux CI) the notice appears with the first save,
// which fails because nothing can encrypt the key. The keyring host's save
// round-trip is cloud-keys.spec.ts.
test('launch leaves the keyring alone; a key save without one fails and raises the notice', async () => {
  // A service that accepts the verification request, so what fails is the save.
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '[{"t_start":0,"t_end":1,"text":"A blue image","tags":["blue"]}]' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`

  const { app, page } = await launchApp()
  const invoke = (cmd: string, args: unknown = {}) =>
    page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const)
  try {
    await page.waitForFunction(() => typeof (window as any).api?.app?.notices === 'function')
    const keyringNoticeStands = async () =>
      ((await page.evaluate(() => (window as any).api.app.notices())) as Array<{ code: string }>)
        .some((n) => n.code === 'keyring_unavailable')

    expect(await keyringNoticeStands()).toBe(false)

    const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
    test.skip(available, 'this host has a keyring; the save round-trip is cloud-keys.spec.ts')

    await invoke('models_use', { id: 'vlm-online', name: 'Keyed test service', endpoint: { url, model: 'test-vision' }, apiKey: 'sk-test-dummy' })
    await expect.poll(async () => ((await invoke('models_list')) as ModelsView).operations[0]?.phase).toBe('error')
    const view = (await invoke('models_list')) as ModelsView
    expect(view.active.vlm).toBeNull()
    expect(await keyringNoticeStands()).toBe(true)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
