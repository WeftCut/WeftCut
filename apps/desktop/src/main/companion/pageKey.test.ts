// The page key lives in the profile, so a link handed out before a restart
// still opens the page after it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOrCreatePageKey, NODE_PAGE_KEY_IO, PAGE_KEY_FILE } from './pageKey'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const profile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-pagekey-')); dirs.push(d); return d }

describe('loadOrCreatePageKey', () => {
  it('keeps one key across loads', () => {
    const dir = profile()
    const key = loadOrCreatePageKey(dir)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(loadOrCreatePageKey(dir)).toBe(key)
    expect(JSON.parse(fs.readFileSync(path.join(dir, PAGE_KEY_FILE), 'utf8'))).toMatchObject({ page_key: key, created_at: expect.any(String) })
  })

  it('replaces a file that holds no valid key', () => {
    for (const text of ['{ not json', JSON.stringify({ page_key: 'short' }), JSON.stringify({})]) {
      const dir = profile()
      fs.writeFileSync(path.join(dir, PAGE_KEY_FILE), text)
      const key = loadOrCreatePageKey(dir)
      expect(key, text).toMatch(/^[0-9a-f]{64}$/)
      expect(loadOrCreatePageKey(dir), text).toBe(key)
    }
  })

  it.skipIf(process.platform === 'win32')('writes the file owner-only', () => {
    const dir = profile()
    loadOrCreatePageKey(dir)
    expect(fs.statSync(path.join(dir, PAGE_KEY_FILE)).mode & 0o777).toBe(0o600)
  })

  it('still answers with a key when the profile cannot be written', () => {
    const dir = profile()
    const failing = { ...NODE_PAGE_KEY_IO, write: { ...NODE_PAGE_KEY_IO.write, open: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }) } } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(loadOrCreatePageKey(dir, failing)).toMatch(/^[0-9a-f]{64}$/)
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore() }
    expect(fs.existsSync(path.join(dir, PAGE_KEY_FILE))).toBe(false)
  })
})
