import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

import { devToolsPort, legacyInvocation, packagedApp, runAsNodeFuse } from './check-packaged-cli-lib.mjs'

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

/// An Electron binary in small: bytes around one fuse wire per entry of
/// `wires`, each a string of fuse states ('0' off, '1' on, 'r' removed).
function binary(...wires) {
  const parts = [Buffer.from('\x7fELF code before')]
  for (const wire of wires) {
    parts.push(Buffer.from(SENTINEL, 'latin1'), Buffer.from([1, wire.length]), Buffer.from(wire, 'latin1'), Buffer.from('code between'))
  }
  return Buffer.concat(parts)
}

test('the RunAsNode fuse is the first of the wire, read as off, on or removed', () => {
  assert.deepEqual(runAsNodeFuse(binary('01001011')), ['off'])
  assert.deepEqual(runAsNodeFuse(binary('10110100')), ['on'])
  assert.deepEqual(runAsNodeFuse(binary('r1001011')), ['removed'])
})

test('every wire of a binary is reported, so one flipped slice cannot hide another', () => {
  assert.deepEqual(runAsNodeFuse(binary('01001011', '11001011')), ['off', 'on'])
})

test('a binary without a fuse wire reports none, and an unknown wire version is refused', () => {
  assert.deepEqual(runAsNodeFuse(Buffer.from('not an Electron binary')), [])
  const future = binary('01001011')
  future[future.indexOf(SENTINEL) + SENTINEL.length] = 2
  assert.throws(() => runAsNodeFuse(future), /fuse wire version 2/)
})

test('the unpacked app is where electron-builder leaves it on each OS', () => {
  assert.deepEqual(packagedApp('linux', '/repo/release'), {
    executable: '/repo/release/linux-unpacked/WeftCut',
    fuseFile: '/repo/release/linux-unpacked/WeftCut',
  })
  assert.deepEqual(packagedApp('win32', 'C:\\repo\\release'), {
    executable: 'C:\\repo\\release\\win-unpacked\\WeftCut.exe',
    fuseFile: 'C:\\repo\\release\\win-unpacked\\WeftCut.exe',
  })
  const mac = packagedApp('darwin', '/repo/release')
  assert.equal(mac.executable, '/repo/release/mac-arm64/WeftCut.app/Contents/MacOS/WeftCut')
  assert.equal(mac.fuseFile, '/repo/release/mac-arm64/WeftCut.app/Contents/Frameworks/Electron Framework.framework/Electron Framework')
  assert.throws(() => packagedApp('freebsd', '/repo/release'), /Unsupported platform/)
})

test('the executable names follow electron-builder.yml', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  for (const [platform, suffix] of [['linux', ''], ['win32', '.exe'], ['darwin', '']]) {
    const { executable } = packagedApp(platform, platform === 'win32' ? 'C:\\r' : '/r')
    assert.ok(executable.endsWith(`${config.executableName}${suffix}`), executable)
  }
  assert.ok(packagedApp('darwin', '/r').executable.includes(`/${config.productName}.app/`))
})

test('the packaged app is built with the RunAsNode fuse off, and no other fuse set', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.deepEqual(config.electronFuses, { runAsNode: false })
})

test('an old config starts the app on the shim script, as Node, naming its profile', () => {
  assert.deepEqual(legacyInvocation('linux', '/home/u/.config/WeftCut'), {
    args: ['/home/u/.config/WeftCut/cli/weftcut-mcp.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', WEFTCUT_USERDATA: '/home/u/.config/WeftCut' },
  })
  assert.deepEqual(legacyInvocation('win32', 'C:\\Users\\u\\AppData\\Roaming\\WeftCut').args, [
    'C:\\Users\\u\\AppData\\Roaming\\WeftCut\\cli\\weftcut-mcp.cjs',
  ])
})

test('the DevTools port is read from the line Chromium announces it on', () => {
  assert.equal(devToolsPort('[1:2] noise\n\nDevTools listening on ws://127.0.0.1:38341/devtools/browser/0b5f\n'), 38341)
  assert.equal(devToolsPort('[1:2] noise\n'), null)
})
