// electron-builder.yml and package.json cannot read cli/identity.json, so they
// carry its names as copies; this holds each copy to it. The `weftcut` binary
// finds and starts the app by these names (cli/launch.go, cli/profile.go).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

import { cliBinaryFile, identity } from './cli-identity.mjs'

const builder = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('electron-builder.yml packages the app under the identity names', () => {
  assert.equal(builder.appId, identity.bundleId, 'appId: the bundle id `open -b` starts the app by')
  assert.equal(builder.productName, identity.productName)
  // The binary looks for the app's executable beside its resources by this name.
  assert.equal(builder.executableName, identity.productName)
})

test("electron-builder.yml ships the binary under its identity name, and nothing else from its build folder", () => {
  const shipped = builder.extraResources.filter((entry) => entry.from === 'out/cli')
  assert.equal(shipped.length, 1, 'one extraResources entry carries out/cli')
  assert.deepEqual([...shipped[0].filter].sort(), [cliBinaryFile('linux'), cliBinaryFile('win32')].sort())
})

test('package.json names the profile directory Electron gives the app', () => {
  // Electron names userData after productName, and after the package name
  // where productName is absent: the binary looks in both.
  assert.equal(pkg.productName, identity.productName)
  assert.equal(pkg.name, identity.packageName)
})

test('the binary file name is bare, with .exe on Windows alone', () => {
  assert.equal(cliBinaryFile('linux'), identity.binaryName)
  assert.equal(cliBinaryFile('darwin'), identity.binaryName)
  assert.equal(cliBinaryFile('win32'), `${identity.binaryName}.exe`)
  assert.doesNotMatch(identity.binaryName, /[\\/.]/)
})
