import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ownProcessTree, closeProcessTree, CLOSE_LIMIT_MS, FFMPEG_GRACE_MS } from './process-cleanup.mjs'

// A close that times out lists every process for its report. On Windows that
// is a CIM query through PowerShell, which process-cleanup.mjs allows 15 s.
const TIMED_OUT_CLOSE_MS = 30_000

// A close that succeeds returns when the tree is gone; its tests only need a
// timeout above the limit the close itself gives up at.
const HEALTHY_CLOSE_MS = CLOSE_LIMIT_MS + 30_000

// The first CIM query on a Windows runner takes longer than the 15 s a listing
// is allowed (the next one about 1 s), and a listing that timed out reports no
// process. Make that first query here, outside any test and its limits.
if (process.platform === 'win32') {
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -First 1 | Out-Null'],
    { stdio: 'ignore', timeout: 120_000, windowsHide: true })
}

test('owned process output cannot block work or graceful shutdown', { timeout: HEALTHY_CLOSE_MS }, async () => {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const output = Buffer.alloc(1024 * 1024, 'x');
    fs.writeSync(1, output);
    fs.writeSync(2, output);
  `], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = ownProcessTree(child)
  try {
    await closeProcessTree(owner, () => owner.reaped)
    assert.equal(child.exitCode, 0)
  } finally { owner.force() }
})

test('blocked graceful close kills descendants that retain the leader stdio', { timeout: TIMED_OUT_CLOSE_MS }, async () => {
  const program = `
    const {spawn} = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 1, 2]});
    process.stdout.write(String(grandchild.pid));
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', program], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = ownProcessTree(child)
  try {
    const [data] = await once(child.stdout, 'data')
    const descendant = Number(String(data))
    assert.ok(descendant > 0)
    await assert.rejects(closeProcessTree(owner, () => new Promise(() => {}), 25), error => {
      assert.match(error.message, /graceful close timed out/)
      assert.match(error.message, new RegExp(`main process ${child.pid}: still running`))
      assert.match(error.message, new RegExp(`left ${descendant} \\(parent ${child.pid}\\)`))
      return true
    })
    await owner.reaped // A leader-only kill leaves this pending: child keeps pipes open.
    assert.ok(child.signalCode !== null || child.exitCode !== null)
  } finally { owner.force() }
})

test('graceful quit does not terminate or report a healthy app as a failure', { timeout: HEALTHY_CLOSE_MS }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'pipe' })
  const owner = ownProcessTree(child)
  try {
    await closeProcessTree(owner, async () => { child.kill(); await owner.reaped })
  } finally { owner.force() }
})

test('POSIX cleanup still owns helpers after the detached leader exits', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const program = `
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 1, 2]});
    process.stdout.write('ready', () => process.exit(0));
  `
  const child = spawn(process.execPath, ['-e', program], { detached: true, stdio: 'pipe' })
  const owner = ownProcessTree(child)
  const exited = once(child, 'exit')
  try {
    await exited
    assert.equal(child.exitCode, 0)
    await assert.rejects(closeProcessTree(owner, () => owner.reaped, 25), error => {
      assert.match(error.message, /graceful close timed out/)
      // The helper holds the pipes of a leader that is already gone.
      assert.match(error.message, new RegExp(`main process ${child.pid}: exited \\(code 0\\), its stdio still open\\n  left \\d+ `))
      return true
    })
    await owner.reaped
  } finally { owner.force() }
})

test('a close that timed out runs the hang command against the live leader before the kill', { timeout: TIMED_OUT_CLOSE_MS }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-hang-command-'))
  const seen = path.join(folder, 'seen')
  // The probe signals nothing (signal 0): it records whether the leader was still there.
  const probe = path.join(folder, 'probe.cjs')
  fs.writeFileSync(probe, `
    const pid = Number(process.env.WEFTCUT_E2E_HUNG_PID);
    let state = 'gone';
    try { process.kill(pid, 0); state = 'alive'; } catch {}
    require('node:fs').writeFileSync(${JSON.stringify(seen)}, pid + ' ' + state);
  `)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = ownProcessTree(child)
  process.env.WEFTCUT_E2E_CLOSE_HANG_CMD = `"${process.execPath}" "${probe}"`
  try {
    await assert.rejects(closeProcessTree(owner, () => new Promise(() => {}), 25), /graceful close timed out/)
    assert.equal(fs.readFileSync(seen, 'utf8'), `${child.pid} alive`)
    await owner.reaped
  } finally {
    delete process.env.WEFTCUT_E2E_CLOSE_HANG_CMD
    owner.force()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('Windows names the app behind the shell Playwright starts it through', { timeout: TIMED_OUT_CLOSE_MS, skip: process.platform !== 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-hang-shell-'))
  const seen = path.join(folder, 'seen')
  const probe = path.join(folder, 'probe.cjs')
  fs.writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(seen)}, String(process.env.WEFTCUT_E2E_HUNG_PID))`)
  const child = spawn(`"${process.execPath}" -e "console.log(process.pid); setInterval(() => {}, 1000)"`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = ownProcessTree(child)
  process.env.WEFTCUT_E2E_CLOSE_HANG_CMD = `"${process.execPath}" "${probe}"`
  try {
    const [data] = await once(child.stdout, 'data')
    const main = Number(String(data))
    await assert.rejects(closeProcessTree(owner, () => new Promise(() => {}), 25), error => {
      assert.match(error.message, new RegExp(`shell ${child.pid}: still running\\nmain process ${main}: still running`))
      return true
    })
    assert.equal(fs.readFileSync(seen, 'utf8'), String(main))
    await owner.reaped
  } finally {
    delete process.env.WEFTCUT_E2E_CLOSE_HANG_CMD
    owner.force()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('POSIX graceful close also stops native children with separate stdio', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-child-heartbeat-'))
  const heartbeat = path.join(folder, 'heartbeat')
  const writer = `const fs = require('node:fs'); const write = () => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())); write(); process.send('ready'); setInterval(write, 20)`
  const program = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.once('message', () => process.stdout.write(String(child.pid), () => process.exit(0)));
  `
  const child = spawn(process.execPath, ['-e', program], { detached: true, stdio: 'pipe' })
  const owner = ownProcessTree(child)
  let descendant
  try {
    const [data] = await once(child.stdout, 'data')
    descendant = Number(String(data))
    await closeProcessTree(owner, () => owner.reaped)
    const stopped = fs.readFileSync(heartbeat, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped, 'native child continued after the app closed')
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch { /* Reaped. */ } }
    owner.force()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

/** A detached stand-in for Electron whose child runs under the executable name
 * `name`: a symlink to bash, so ps reports it like the real binary (node would
 * not do: it renames its main thread). Both record a SIGTERM; the leader keeps
 * running on it, like Electron's blocked quit. */
async function treeWithNamedChild(folder, name, { childExitsOnTerm, leaderExits, ffmpegGraceMs }) {
  fs.mkdirSync(path.join(folder, 'bin'))
  const binary = path.join(folder, 'bin', name)
  fs.symlinkSync(fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', binary)
  // Records sit apart from the symlink: writing through it would hit the shell.
  const record = file => path.join(folder, `${file}.term`)
  const script = `trap 'echo TERM >> "${record(name)}"${childExitsOnTerm ? '; exit 0' : ''}' TERM; echo ready; while :; do sleep 0.05; done`
  const program = `
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(record('leader'))}, 'TERM\\n'));
    const tool = spawn(${JSON.stringify(binary)}, ['-c', ${JSON.stringify(script)}], {stdio: ['pipe', 'pipe', 'ignore']});
    tool.stdout.once('data', () => process.stdout.write(String(tool.pid), () => { ${leaderExits ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'} }));
  `
  const child = spawn(process.execPath, ['-e', program], { detached: true, stdio: 'pipe' })
  const owner = ownProcessTree(child, { ffmpegGraceMs })
  const [data] = await once(child.stdout, 'data')
  return { child, owner, tool: Number(String(data)) }
}

// A grace no healthy run waits out: a cleanup that returns inside it did not
// wait for the kill.
const LONG_GRACE_MS = 20_000

// Running, not merely an unreaped zombie under init.
const alive = pid => { const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return state.status === 0 && !state.stdout.trim().startsWith('Z') }
const terms = (folder, name) => { const file = path.join(folder, `${name}.term`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }

test('POSIX forced close gives an ffmpeg descendant SIGTERM and a bounded grace before the kill', { timeout: TIMED_OUT_CLOSE_MS, skip: process.platform === 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-ffmpeg-term-'))
  let tree
  try {
    // ffprobe ignores SIGTERM, so the grace runs out and the group kill follows.
    tree = await treeWithNamedChild(folder, 'ffprobe', { childExitsOnTerm: false, leaderExits: false })
    const started = Date.now()
    await assert.rejects(closeProcessTree(tree.owner, () => new Promise(() => {}), 25), /graceful close timed out/)
    await tree.owner.reaped
    const elapsed = Date.now() - started
    assert.match(terms(folder, 'ffprobe'), /^TERM\n$/, 'ffprobe was killed without a SIGTERM first')
    assert.equal(terms(folder, 'leader'), '', 'the app itself got SIGTERM')
    assert.equal(tree.child.signalCode, 'SIGKILL')
    assert.ok(!alive(tree.tool), 'ffprobe outlived the grace')
    // The kill above shows the grace ended; this, that it was not cut short.
    assert.ok(elapsed >= FFMPEG_GRACE_MS - 100, `the kill came ${elapsed} ms in, before the grace was over`)
  } finally {
    if (tree && alive(tree.tool)) process.kill(tree.tool, 'SIGKILL')
    tree?.owner.force()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('POSIX cleanup after the app exits lets its ffmpeg end on SIGTERM before the group kill', { timeout: 2 * LONG_GRACE_MS, skip: process.platform === 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-ffmpeg-term-'))
  let tree
  try {
    tree = await treeWithNamedChild(folder, 'ffmpeg', { childExitsOnTerm: true, leaderExits: true, ffmpegGraceMs: LONG_GRACE_MS })
    const started = Date.now()
    await closeProcessTree(tree.owner, () => tree.owner.reaped)
    const elapsed = Date.now() - started
    assert.equal(tree.child.exitCode, 0)
    assert.match(terms(folder, 'ffmpeg'), /^TERM\n$/, 'ffmpeg was killed without a SIGTERM first')
    assert.ok(!alive(tree.tool), 'ffmpeg outlived app cleanup')
    assert.ok(elapsed < LONG_GRACE_MS, `an ffmpeg that ended on SIGTERM still waited out the grace (${elapsed} ms)`)
  } finally {
    if (tree && alive(tree.tool)) process.kill(tree.tool, 'SIGKILL')
    tree?.owner.force()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
