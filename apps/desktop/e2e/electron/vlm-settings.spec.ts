import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, tmpDir } from './helpers/driver'

/// Video-understanding config, end to end through the real keyring.
///
/// The twin of `cloud-keys.spec.ts`, and it exists for the seam neither unit
/// suite can reach: `main/vlm-config.test.ts` runs on an injected in-memory fs
/// and never calls `safeStorage`, while `settings/VlmSection.test.tsx` mocks the
/// whole IPC layer. So "renderer sets a key → main encrypts it → keyring → back
/// out as the resolver's snapshot" has no coverage anywhere below this file, and
/// the property that matters most — the key is NOT on disk in plaintext — is
/// only observable with a real userData dir under it.
///
/// Driven through `api.backend.invoke` rather than the Settings UI on purpose:
/// the panel's rendering is already unit-tested against a mocked IPC, and what
/// is unverified is the main-process half those mocks stand in for.

const URL_A = 'http://localhost:8080/v1/chat/completions'
const KEY_A = 'sk-vlm-e2e-dummy'

interface EndpointInfo {
  url: string
  model?: string
  has_api_key: boolean
}
interface BackendRow {
  backend: string
  locality: string
  availability: string
  selected: boolean
  endpoint?: EndpointInfo
}
interface BackendsView {
  preferred_engine: string
  backends: BackendRow[]
}

/// The renderer-side bridges these specs read main-owned files with. `fs:*` and
/// `path:*` are their own `api.*` methods — routing them through
/// `backend.invoke` would hit the Rust dispatcher's "unknown command".
function bridge(page: import('@playwright/test').Page) {
  return {
    invoke: (cmd: string, args: unknown) =>
      page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const),
    readText: (p: string) =>
      page.evaluate(
        async (f) => new TextDecoder().decode(await (window as any).api.fs.readFile(f)),
        p,
      ) as Promise<string>,
    exists: (p: string) =>
      page.evaluate((f) => (window as any).api.fs.exists(f), p) as Promise<boolean>,
    join: (parts: string[]) =>
      page.evaluate((ps) => (window as any).api.path.join(ps), parts) as Promise<string>,
  }
}

test('the endpoint key round-trips through safeStorage and never lands in vlm_config.json', async () => {
  const { app, page } = await launchApp()
  try {
    const { invoke, readText, exists, join } = bridge(page)
    const userData = (await app.evaluate(({ app }) => app.getPath('userData'))) as string

    // Skip where there is no OS keyring (headless Linux CI): `setKey` calls
    // safeStorage.encryptString, which throws "Encryption is not available".
    // Same guard, same reason, as cloud-keys.spec.ts.
    const encryptionAvailable = (await app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    )) as boolean
    test.skip(
      !encryptionAvailable,
      'safeStorage encryption unavailable (no OS keyring) — the round-trip is verified where a keyring exists (Windows/macOS/Linux-desktop)',
    )

    const keysPath = await join([userData, 'cloud_keys.json'])
    const cfgPath = await join([userData, 'vlm_config.json'])

    // The removed backend is gated here, not just in the Rust unit tests: this
    // is the listing the panel actually renders, so a re-added cloud row would
    // show up as a row with nothing to configure.
    const before = (await invoke('settings_get_vlm_backends', {})) as BackendsView
    expect(before.backends.map((b) => b.backend)).toEqual([
      'qwen3_vl',
      'minicpm_v',
      'byo_endpoint',
    ])
    expect(before.backends.some((b) => b.locality === 'cloud')).toBe(false)
    expect(before.backends.every((b) => b.availability !== 'needs_key')).toBe(true)

    await invoke('settings_set_vlm_endpoint', { url: URL_A, model: 'qwen2-vl', apiKey: KEY_A })

    // (a) The key is an encrypted blob under its OWN tag, and the non-secret
    // store carries no trace of it — that split is the whole point of the
    // change, so both halves are asserted, not just the presence of the blob.
    const stored = JSON.parse(await readText(keysPath)) as Record<string, string>
    expect(typeof stored.vlm_endpoint).toBe('string')
    expect(stored.vlm_endpoint).not.toContain(KEY_A)
    // Not the speech section's entry: one secret, one editor.
    expect(stored.openai).toBeUndefined()

    const cfgText = await readText(cfgPath)
    expect(cfgText).toContain(URL_A)
    expect(cfgText).not.toContain(KEY_A)
    expect(cfgText).not.toContain('api_key')

    // (b) The renderer learns presence, never material — including in the raw
    // payload, so a future field that leaks the key fails here.
    const view = (await invoke('settings_get_vlm_backends', {})) as BackendsView
    expect(JSON.stringify(view)).not.toContain(KEY_A)
    const endpointRow = view.backends.find((b) => b.backend === 'byo_endpoint')!
    expect(endpointRow.endpoint).toEqual({ url: URL_A, model: 'qwen2-vl', has_api_key: true })
    // URL-gated, never key-gated: the row is available on the URL alone.
    expect(endpointRow.availability).toBe('available')
    expect(endpointRow.selected).toBe(true)

    // An untouched key field omits `apiKey`; the stored key must survive that.
    await invoke('settings_set_vlm_endpoint', { url: URL_A, model: 'other-vlm' })
    const kept = JSON.parse(await readText(keysPath)) as Record<string, string>
    expect(kept.vlm_endpoint).toBe(stored.vlm_endpoint)
    const keptView = (await invoke('settings_get_vlm_backends', {})) as BackendsView
    expect(keptView.backends.find((b) => b.backend === 'byo_endpoint')!.endpoint).toEqual({
      url: URL_A,
      model: 'other-vlm',
      has_api_key: true,
    })

    // (c) Clearing the endpoint takes the credential with it — a key with no URL
    // to send it to is a secret kept for nothing.
    await invoke('settings_set_vlm_endpoint', { url: '' })
    if (await exists(keysPath)) {
      const after = JSON.parse(await readText(keysPath)) as Record<string, string>
      expect(after.vlm_endpoint).toBeUndefined()
    }
    const cleared = (await invoke('settings_get_vlm_backends', {})) as BackendsView
    const clearedRow = cleared.backends.find((b) => b.backend === 'byo_endpoint')!
    expect(clearedRow.endpoint).toBeUndefined()
    expect(clearedRow.availability).toBe('needs_endpoint')
  } finally {
    await app.close()
  }
})

test('a legacy plaintext endpoint key migrates into safeStorage at boot and is scrubbed', async () => {
  // The migration is a ONCE-PER-PROFILE path — the class of code that ships
  // broken and is never noticed — so it gets the only two-launch test here.
  //
  // Shape: launch, let the app tell us where its userData really is (a guessed
  // path would seed the wrong file and pass without exercising anything), write
  // the old build's plaintext shape there, relaunch over the same dir.
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
  // beside the non-secret fields.
  const cfgPath = path.join(userData, 'vlm_config.json')
  fs.mkdirSync(userData, { recursive: true })
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
    const { invoke, readText, exists, join } = bridge(second.page)
    const keysPath = await join([userData, 'cloud_keys.json'])

    // (d) Moved into the keyring encrypted, and gone from the file — both, or
    // the migration has only half happened.
    //
    // Existence is asserted before the read so a migration that never ran fails
    // as "no keyring file" rather than as an ENOENT out of the fs bridge.
    expect(
      await exists(keysPath),
      'no cloud_keys.json — takeLegacyEndpointKey did not move the key',
    ).toBe(true)
    const stored = JSON.parse(await readText(keysPath)) as Record<string, string>
    expect(typeof stored.vlm_endpoint).toBe('string')
    expect(stored.vlm_endpoint).not.toContain(KEY_A)

    const cfgText = await readText(cfgPath)
    expect(cfgText).not.toContain(KEY_A)
    expect(cfgText).not.toContain('api_key')
    // The non-secret fields the same file holds are untouched by the scrub.
    expect(cfgText).toContain(URL_A)

    // And the migrated key is live: the endpoint reports it and still resolves.
    const view = (await invoke('settings_get_vlm_backends', {})) as BackendsView
    expect(view.preferred_engine).toBe('byo_endpoint')
    const row = view.backends.find((b) => b.backend === 'byo_endpoint')!
    expect(row.endpoint).toEqual({ url: URL_A, model: 'qwen2-vl', has_api_key: true })
    expect(row.availability).toBe('available')
  } finally {
    await second.app.close()
  }
})

test('a retired preferred_engine tag on disk degrades to automatic', async () => {
  // `"cloud"` is what a config written before the backend was removed holds. It
  // must read as "no preference", not survive as a tag no resolver knows — and
  // must not blank the Settings selector, which is what an undefined would do.
  const userDataDir = tmpDir('weftcut-e2e-vlm-retired-')

  const first = await launchApp({ userDataDir })
  let userData = ''
  try {
    userData = (await first.app.evaluate(({ app }) => app.getPath('userData'))) as string
  } finally {
    await first.app.close()
  }

  // The endpoint rides along as the PROOF THE FILE WAS READ. Seeding only the
  // retired tag would pass vacuously: a config the app never found also reports
  // "auto", so the assertion below would hold for the wrong reason.
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, 'vlm_config.json'),
    JSON.stringify(
      { preferred_engine: 'cloud', local: {}, endpoint: { url: URL_A } },
      null,
      2,
    ),
  )

  const second = await launchApp({ userDataDir })
  try {
    const { invoke } = bridge(second.page)
    const view = (await invoke('settings_get_vlm_backends', {})) as BackendsView
    const row = view.backends.find((b) => b.backend === 'byo_endpoint')!
    expect(row.endpoint?.url).toBe(URL_A) // the seeded file really was loaded
    expect(view.preferred_engine).toBe('auto')
    // Degrading to automatic is not the same as picking nothing: the walk then
    // resolves by availability, and the endpoint is the one thing configured.
    expect(row.selected).toBe(true)
  } finally {
    await second.app.close()
  }
})
