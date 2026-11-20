import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/// Told the outcome of every keyring check, so main can raise or retract the
/// `keyring_unavailable` notice.
let reportKeyring: (available: boolean) => void = () => {}

export function onKeyringChecked(listener: (available: boolean) => void): void {
  reportKeyring = listener
}

/// Whether the OS keyring backs safeStorage right now. Asked only when a key
/// is about to be encrypted or decrypted, never at launch: on macOS the check
/// reads the app's Keychain item and on Linux it reaches libsecret or KWallet,
/// either of which can put a system prompt in front of a user who has not
/// touched a cloud model yet.
function keyringAvailable(): boolean {
  let available = false
  try { available = safeStorage.isEncryptionAvailable() } catch { /* stays false */ }
  reportKeyring(available)
  return available
}

const KEYS_FILE = () => path.join(app.getPath('userData'), 'cloud_keys.json')

/// On-disk shape: { "<provider>": "<base64(safeStorage.encryptString)>" }.
type Stored = Record<string, string>

function readStored(): Stored {
  try {
    const raw = fs.readFileSync(KEYS_FILE(), 'utf8')
    const obj = JSON.parse(raw) as Stored
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function writeStored(s: Stored): void {
  const target = KEYS_FILE()
  fs.writeFileSync(target + '.tmp', JSON.stringify(s), 'utf8')
  fs.renameSync(target + '.tmp', target)
}

/// Decrypt every stored key. A blob that fails to decrypt (OS backend rotated,
/// corrupt entry) is dropped from the file and skipped — never throws. With no
/// keyring nothing is decrypted and nothing is dropped: the blobs are intact
/// and read again once the keyring is back.
export function loadAllKeys(): Record<string, string> {
  const stored = readStored()
  if (Object.keys(stored).length === 0 || !keyringAvailable()) return {}
  const out: Record<string, string> = {}
  let mutated = false
  for (const [provider, b64] of Object.entries(stored)) {
    try {
      out[provider] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      delete stored[provider]
      mutated = true
    }
  }
  if (mutated) {
    try { writeStored(stored) } catch { /* Reading usable keys never fails on cleanup. */ }
  }
  return out
}

/// Encrypt + persist one provider key. Trims; empty key is a no-op clear.
/// Throws, writing nothing, when no keyring can encrypt it.
export function setKey(provider: string, key: string): void {
  const trimmed = (key ?? '').trim()
  if (trimmed && !keyringAvailable()) throw new Error('No system keyring is available, so the key was not saved.')
  const stored = readStored()
  if (!trimmed) {
    delete stored[provider]
  } else {
    stored[provider] = safeStorage.encryptString(trimmed).toString('base64')
  }
  writeStored(stored)
}

/// Remove one provider key (idempotent).
export function clearKey(provider: string): void {
  const stored = readStored()
  delete stored[provider]
  writeStored(stored)
}
