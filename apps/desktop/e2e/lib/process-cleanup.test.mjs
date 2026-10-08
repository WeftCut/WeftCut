import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ownProcessTree, closeProcessTree } from './process-cleanup.mjs'

test('blocked graceful close kills descendants that retain the leader stdio', { timeout: 5000 }, async () => {
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
    await assert.rejects(closeProcessTree(owner, () => new Promise(() => {}), 25), /graceful close timed out/)
    await owner.reaped // A leader-only kill leaves this pending: child keeps pipes open.
    assert.ok(child.signalCode !== null || child.exitCode !== null)
  } finally { owner.force() }
})

test('graceful quit does not terminate or report a healthy app as a failure', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'pipe' })
  const owner = ownProcessTree(child)
  try {
    await closeProcessTree(owner, async () => { child.kill(); await owner.reaped }, 1000)
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
    await assert.rejects(closeProcessTree(owner, () => owner.reaped, 25), /graceful close timed out/)
    await owner.reaped
  } finally { owner.force() }
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
