import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, tmpDir } from './helpers/driver'
import type { ModelsView } from '../../src/shared/inference-models'

/// A video-understanding config from before model profiles, upgraded through
/// the real keyring. `main/vlm-config.test.ts` and `main/model-settings.test.ts`
/// cover each step on injected stores; only a real userData dir shows the key
/// leaving the file in plaintext and arriving in the keyring encrypted.

const URL_A = 'http://localhost:8080/v1/chat/completions'
const KEY_A = 'sk-vlm-e2e-dummy'

test('a legacy plaintext endpoint key becomes an encrypted model credential at boot', async () => {
  // A ONCE-PER-PROFILE path — the class of code that ships broken and is never
  // noticed — so it gets a two-launch test.
  //
  // Shape: launch, let the app tell us where its userData really is (a guessed
  // path would seed the wrong file and pass without exercising anything), write
  // the old build's files there, relaunch over the same dir.
  const userDataDir = tmpDir('weftcut-e2e-vlm-migrate-')

  const first = await launchApp({ userDataDir })
  let userData = ''
  try {
    const encryptionAvailable = (await first.app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    )) as boolean
    test.skip(!encryptionAvailable, 'safeStorage encryption unavailable (no OS keyring)')
    userData = (await first.app.evaluate(({ app }) => app.getPath('userData'))) as string
  } finally {
    await first.app.close()
  }

  // Exactly what a build before `c07d3bd3` persisted: the key in the clear,
  // beside the non-secret fields, and no model settings yet — the first launch
  // wrote some, and leaving them would skip the migration under test.
  const cfgPath = path.join(userData, 'vlm_config.json')
  fs.rmSync(path.join(userData, 'model_settings.json'), { force: true })
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        preferred_engine: 'byo_endpoint',
        local: {},
        endpoint: { url: URL_A, model: 'qwen2-vl', api_key: KEY_A },
      },
      null,
      2,
    ),
  )

  const second = await launchApp({ userDataDir })
  try {
    const invoke = (cmd: string, args: unknown = {}) =>
      second.page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const)

    // The selection survives as a model profile that holds the key.
    const view = (await invoke('models_list')) as ModelsView
    const active = view.models.find((m) => m.id === view.active.vlm)
    expect(active?.endpoint).toMatchObject({ url: URL_A, model: 'qwen2-vl' })
    expect(active?.hasKey).toBe(true)

    // The key is in the keyring file encrypted, and in no plain file.
    const keysPath = path.join(userData, 'cloud_keys.json')
    expect(fs.existsSync(keysPath), 'no cloud_keys.json — the legacy key was not moved').toBe(true)
    const keys = fs.readFileSync(keysPath, 'utf8')
    expect(keys).not.toContain(KEY_A)
    for (const file of ['vlm_config.json', 'model_settings.json']) {
      expect(fs.readFileSync(path.join(userData, file), 'utf8')).not.toContain(KEY_A)
    }
    // The scrub touches only the key: the file's non-secret fields stay.
    const cfgText = fs.readFileSync(cfgPath, 'utf8')
    expect(cfgText).not.toContain('api_key')
    expect(cfgText).toContain(URL_A)
  } finally {
    await second.app.close()
  }
})
