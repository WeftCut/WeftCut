import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  assertMacPortable, machOFiles, macMinimumSystemVersion, parseLoadCommands, portabilityProblems,
} from './macho-portability.mjs'
import afterPackMacosPortable from './after-pack-macos-portable.mjs'
import { MAC_SYSTEM_LIBRARIES, macConfigureArgs } from './fetch-ffmpeg-lgpl.mjs'

/// `otool -l` text for one binary: its own id, the libraries it loads, its minimum macOS.
function loadCommands({ id, loads = [], weak = [], minos = '13.0', legacy = false }) {
  const dylib = (cmd, name) => `Load command\n          cmd ${cmd}\n      cmdsize 56\n         name ${name} (offset 24)\n   time stamp 2 Thu Jan  1 00:00:02 1970\n`
  const version = legacy
    ? `Load command\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version ${minos}\n      sdk 26.0\n`
    : `Load command\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minos}\n      sdk 26.0\n   ntools 1\n`
  return [id && dylib('LC_ID_DYLIB', id), version, ...loads.map(n => dylib('LC_LOAD_DYLIB', n)),
    ...weak.map(n => dylib('LC_LOAD_WEAK_DYLIB', n))].filter(Boolean).join('')
}

test('the minimum macOS and the loaded libraries are read from the load commands, not the dylib id', () => {
  const parsed = parseLoadCommands(loadCommands({
    id: '/Users/runner/work/install/lib/libavutil.60.dylib',
    loads: ['@loader_path/libavutil.60.dylib', '/usr/lib/libSystem.B.dylib'],
    weak: ['/System/Library/Frameworks/Metal.framework/Versions/A/Metal'],
    minos: '13.0',
  }))
  assert.deepEqual(parsed.deps.sort(), ['/System/Library/Frameworks/Metal.framework/Versions/A/Metal',
    '/usr/lib/libSystem.B.dylib', '@loader_path/libavutil.60.dylib'])
  assert.equal(parsed.minos, '13.0')
  assert.equal(parseLoadCommands(loadCommands({ minos: '10.15', legacy: true })).minos, '10.15')
  // A universal binary is only as portable as its least portable slice.
  assert.equal(parseLoadCommands(loadCommands({ minos: '11.0' }) + loadCommands({ minos: '14.2' })).minos, '14.2')
})

test('a binary that loads a host-installed library or targets a newer macOS is refused', () => {
  const floor = '13.0'
  const portable = { deps: ['/usr/lib/libz.1.dylib', '@rpath/Electron Framework.framework/Electron Framework',
    '@loader_path/libavcodec.62.dylib', '@executable_path/../Frameworks/x'], minos: '13.0' }
  assert.deepEqual(portabilityProblems('ok', portable, floor), [])
  assert.deepEqual(portabilityProblems('older', { ...portable, minos: '11.0' }, floor), [])

  for (const dep of ['/opt/homebrew/opt/libx11/lib/libX11.6.dylib', '/usr/local/lib/libfoo.dylib',
    '/Users/runner/work/install/lib/libavutil.60.dylib']) {
    assert.match(portabilityProblems('lib', { ...portable, deps: [dep] }, floor).join(), /which no user's Mac provides/)
  }
  assert.match(portabilityProblems('lib', { ...portable, minos: '26.0' }, floor).join(), /requires macOS 26\.0; the app supports 13\.0/)
  assert.match(portabilityProblems('lib', { ...portable, minos: '13.1' }, floor).join(), /requires macOS 13\.1/)
  assert.match(portabilityProblems('lib', { ...portable, minos: null }, floor).join(), /declares no minimum macOS/)
})

test('the gate names every non-portable binary at once', () => {
  const texts = {
    a: loadCommands({ loads: ['/opt/homebrew/opt/libx11/lib/libX11.6.dylib'] }),
    b: loadCommands({ minos: '26.0' }),
    c: loadCommands({}),
  }
  assert.throws(() => assertMacPortable(['a', 'b', 'c'], { floor: '13.0', label: 'gate:', read: f => texts[f] }),
    error => /gate: 2 portability problems/.test(error.message) && /a loads/.test(error.message) && /b requires/.test(error.message))
  assertMacPortable(['c'], { floor: '13.0', label: 'gate:', read: f => texts[f] })
})

test('Mach-O files are found by content, without following symlinks',
  { skip: process.platform === 'win32' && 'creating symlinks needs privileges on Windows' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-scan-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const thin = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
  const fat = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])
  fs.mkdirSync(path.join(dir, 'Contents/Frameworks/X.framework/Versions/A'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Contents/Frameworks/X.framework/Versions/A/X'), thin)
  fs.symlinkSync('A', path.join(dir, 'Contents/Frameworks/X.framework/Versions/Current'))
  fs.symlinkSync('Versions/Current/X', path.join(dir, 'Contents/Frameworks/X.framework/X'))
  fs.writeFileSync(path.join(dir, 'Contents/app'), fat)
  fs.writeFileSync(path.join(dir, 'Contents/Info.plist'), '<?xml version="1.0"?>')
  fs.writeFileSync(path.join(dir, 'Contents/empty'), '')
  assert.deepEqual(machOFiles(dir).map(f => path.relative(dir, f)),
    ['Contents/Frameworks/X.framework/Versions/A/X', 'Contents/app'])
})

test('the packaged-app gate runs on macOS only, over the .app bundle, at the declared floor', (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-packed-'))
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(appOutDir, 'WeftCut.app/Contents/MacOS'), { recursive: true })
  fs.writeFileSync(path.join(appOutDir, 'WeftCut.app/Contents/MacOS/WeftCut'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  const context = (platform) => ({ appOutDir, electronPlatformName: platform, packager: { appInfo: { productFilename: 'WeftCut' } } })
  const calls = []
  afterPackMacosPortable(context('darwin'), (files, options) => calls.push({ files, options }))
  assert.deepEqual(calls.map(c => c.files.map(f => path.relative(appOutDir, f))), [['WeftCut.app/Contents/MacOS/WeftCut']])
  assert.equal(calls[0].options.floor, macMinimumSystemVersion())
  for (const platform of ['linux', 'win32']) afterPackMacosPortable(context(platform), () => assert.fail('ran off macOS'))
})

test('the macOS ffmpeg build links only SDK libraries and targets the app\'s minimum macOS', () => {
  const floor = macMinimumSystemVersion()
  assert.match(floor, /^\d+(\.\d+)*$/)
  const args = macConfigureArgs('/prefix', floor)
  assert.ok(args.includes('--disable-autodetect'), 'autodetect links whatever the build host has installed')
  const enabled = args.filter(a => a.startsWith('--enable-') && !['--enable-shared'].includes(a)).map(a => a.slice('--enable-'.length))
  assert.deepEqual(enabled.sort(), [...MAC_SYSTEM_LIBRARIES].sort())
  for (const hostOnly of ['xlib', 'libxcb', 'sdl2', 'vulkan', 'lzma', 'metal']) assert.ok(!enabled.includes(hostOnly), hostOnly)
  assert.ok(args.includes('--disable-iconv'), 'configure would assume a libc iconv and libavcodec would not link')
  for (const flag of ['--extra-cflags', '--extra-ldflags']) assert.ok(args.includes(`${flag}=-mmacosx-version-min=${floor}`), flag)
  assert.ok(!args.some(a => /--enable-(gpl|nonfree)/.test(a)))
})
