import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { DiagnosticsStore, redactDiagnosticText } from './diagnosticsStore'

const roots: string[] = []
const stores: DiagnosticsStore[] = []
const root = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-diagnostics-')); roots.push(p); return p }
const start = (dir: string, alive = () => false) => {
  const s = new DiagnosticsStore(dir, '1.2.3', alive); stores.push(s); return s
}
afterEach(() => {
  stores.splice(0).forEach(s => s.close(true))
  roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true }))
})

it('detects an unfinished session, keeps its evidence, and acknowledges it across restarts', () => {
  const dir = root(), a = start(dir)
  a.setEnvironment({ app: '1.2.3', gpu: 'synthetic GPU' })
  a.record('resources', 'waiting=3 available=256'); a.close(false)
  const b = start(dir)
  expect(b.previous).toMatchObject({ version: '1.2.3', reason: 'unclean-exit' })
  const files = unzipSync(b.bundle({ app: '1.2.4' }))
  expect(strFromU8(files['previous/events.jsonl']!)).toContain('waiting=3')
  expect(JSON.parse(strFromU8(files['previous/environment.json']!)).gpu).toBe('synthetic GPU')
  b.dismissPrevious(); b.close(true)
  const c = start(dir)
  expect(c.previous).toBeNull()
  expect(strFromU8(unzipSync(c.bundle({}))['previous/events.jsonl']!)).toContain('waiting=3')
})

it('does not flag a clean quit or another live instance, but preserves a process failure on clean quit', () => {
  const dir = root(), a = start(dir)
  expect(start(dir, () => true).previous).toBeNull()
  stores[1]!.close(true); a.close(true)
  const b = start(dir)
  expect(b.previous).toBeNull()
  b.failure('render-process-gone', 'reason=oom'); b.close(true)
  expect(start(dir).previous?.reason).toBe('process-failure')
})

it('tolerates corrupt markers without preventing the next session', () => {
  const dir = root(), a = start(dir); a.close(false)
  const id = fs.readdirSync(dir)[0]!
  fs.writeFileSync(path.join(dir, id, 'session.json'), '{')
  expect(start(dir).previous).toBeNull()
})

it('exports the pending incident even when a newer failure has already been acknowledged', () => {
  const dir = root()
  start(dir).close(false); start(dir).close(false)
  const [newer, older] = fs.readdirSync(dir).sort().reverse()
  const marker = path.join(dir, newer!, 'session.json')
  const state = JSON.parse(fs.readFileSync(marker, 'utf8'))
  fs.writeFileSync(marker, JSON.stringify({ ...state, acknowledged: true }))
  const s = start(dir)
  expect(s.previous?.id).toBe(older)
  const files = unzipSync(s.bundle({}))
  expect(JSON.parse(strFromU8(files['previous/session.json']!)).id).toBe(older)
})

it('redacts common credentials, private paths, URLs and email addresses before persistence', () => {
  const s = start(root())
  const secret = String.raw`Bearer abcd1234 api_key="two secret words" C:\Users\Synthetic\private.mp4`
  s.record('error', secret)
  s.record('error', 'failed /home/synthetic/private.mp4 https://user:pass@example.org/api?token=hidden synthetic@example.org ghp_0123456789abcdefgh')
  const files = unzipSync(s.bundle({ app: '1.2.3' }))
  const logs = strFromU8(files['current/events.jsonl']!)
  for (const privateText of ['abcd1234', 'two secret words', 'private.mp4', 'user:pass', 'hidden', 'synthetic@example.org', 'ghp_0123456789abcdefgh']) {
    expect(logs).not.toContain(privateText)
  }
  expect(logs).toContain('[redacted]')
  expect(redactDiagnosticText('password=secret123 token: "two words"')).not.toMatch(/secret123|two words/)
  expect(redactDiagnosticText('failed /Volumes/Private Disk/My Secret/video.mov')).not.toContain('My Secret')
  expect(redactDiagnosticText('Basic c2VjcmV0')).not.toContain('c2VjcmV0')
})

it('bounds log storms, rotates disk logs and prunes inactive sessions', () => {
  const dir = root()
  for (let i = 0; i < 12; i++) start(dir).close(true)
  expect(fs.readdirSync(dir)).toHaveLength(8)
  const s = stores.at(-1)!
  for (let batch = 0; batch < 60; batch++) {
    for (let i = 0; i < 100; i++) s.record('chatter', 'x'.repeat(4000))
    s.flush()
  }
  const files = unzipSync(s.bundle({ app: '1.2.3' }))
  expect(files['current/events.previous.jsonl']).toBeDefined()
  expect(files['current/events.jsonl']!.length).toBeLessThanOrEqual(512 * 1024)
  expect(files['current/events.previous.jsonl']!.length).toBeLessThanOrEqual(512 * 1024)
})

it('reports storage failure without throwing into the application', () => {
  const dir = root(), s = start(dir)
  // Simulate a removed/unavailable log directory.
  fs.rmSync(dir, { recursive: true, force: true })
  s.record('error', 'example'); expect(() => s.flush()).not.toThrow()
  expect(s.available).toBe(false)
  expect(() => s.bundle({})).toThrow('unavailable')
})
