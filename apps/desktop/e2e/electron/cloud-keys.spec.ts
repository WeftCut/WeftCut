import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp } from './helpers/driver'
import type { ModelsView } from '../../src/shared/inference-models'

/// A model's credential, end to end through the real keyring: saved with the
/// model, encrypted at rest, sent to its service, and dropped with the model.
/// `main/model-manager.test.ts` covers the same steps on an injected key store,
/// so only this file sees safeStorage and the files under a real userData dir.

const KEY = 'sk-model-e2e-dummy'

test('a model key is stored encrypted, sent to its service, and removed with the model', async () => {
  // The verification request a service answers before the model is selected.
  // It records the Authorization header so the test can see which key went out.
  const authorizations: string[] = []
  const server = createServer((req, res) => {
    authorizations.push(String(req.headers.authorization ?? ''))
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
    // Skip when the OS keyring is absent (headless Linux CI): saving a key needs
    // safeStorage to encrypt it. safestorage.spec.ts covers that host.
    const encryptionAvailable = (await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())) as boolean
    test.skip(!encryptionAvailable, 'safeStorage encryption unavailable (no OS keyring)')
    const userData = (await app.evaluate(({ app }) => app.getPath('userData'))) as string
    const keysPath = path.join(userData, 'cloud_keys.json')

    await invoke('models_use', { id: 'vlm-online', name: 'Keyed test service', endpoint: { url, model: 'test-vision' }, apiKey: KEY })
    await expect.poll(async () => ((await invoke('models_list')) as ModelsView).active.vlm).toMatch(/^custom-/)
    const view = (await invoke('models_list')) as ModelsView
    const id = view.active.vlm!
    expect(view.models.find((m) => m.id === id)?.hasKey).toBe(true)

    // Sent as the bearer of the verification request.
    expect(authorizations).toContain(`Bearer ${KEY}`)

    // Encrypted in the keyring file under the model's own tag, and nowhere in
    // the clear.
    const stored = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<string, string>
    expect(typeof stored[`model-${id}`]).toBe('string')
    expect(JSON.stringify(stored)).not.toContain(KEY)
    expect(fs.readFileSync(path.join(userData, 'model_settings.json'), 'utf8')).not.toContain(KEY)

    // A credential with no model left to use it is not kept.
    await invoke('models_remove_custom', { id })
    const after = fs.existsSync(keysPath) ? (JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<string, string>) : {}
    expect(after[`model-${id}`]).toBeUndefined()
  } finally {
    // finally, because the test.skip() above THROWS. Without it the app outlives
    // the test, and an app nobody closed is what the worker's own exit ends up
    // waiting on — green tests, and a leg that dies in teardown.
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
