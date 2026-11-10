import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEV_WINDOWS_IDENTITY, PACKAGED_WINDOWS_IDENTITY, windowsAppIdentity } from './appIdentity'

const CLSID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/

describe('Windows app identity', () => {
  // The runtime AUMID and the installer's shortcut stamp (electron-builder.yml
  // `appId`) are two literals that must stay identical, or the taskbar loses
  // the app's icon and grouping.
  it('gives the installed app the AUMID electron-builder stamps on its shortcuts', () => {
    const ymlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'electron-builder.yml')
    const yml = readFileSync(ymlPath, 'utf8')
    const match = yml.match(/^appId:\s*(\S+)\s*$/m)
    expect(match, 'appId: line not found in electron-builder.yml').not.toBeNull()
    expect(match![1]).toBe(PACKAGED_WINDOWS_IDENTITY.appUserModelId)
  })

  it('keeps an unpackaged run off the installed app’s AUMID and toast activator', () => {
    expect(DEV_WINDOWS_IDENTITY.appUserModelId).not.toBe(PACKAGED_WINDOWS_IDENTITY.appUserModelId)
    expect(DEV_WINDOWS_IDENTITY.toastActivatorClsid.toUpperCase()).not.toBe(PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid.toUpperCase())
  })

  // app.setToastActivatorCLSID throws on anything else, and a shortcut stamp
  // compared against a differently written GUID would never match.
  it('writes each toast activator CLSID as a braced upper-case GUID', () => {
    expect(PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid).toMatch(CLSID)
    expect(DEV_WINDOWS_IDENTITY.toastActivatorClsid).toMatch(CLSID)
  })

  it('selects the identity by whether the app is packaged', () => {
    expect(windowsAppIdentity(true)).toBe(PACKAGED_WINDOWS_IDENTITY)
    expect(windowsAppIdentity(false)).toBe(DEV_WINDOWS_IDENTITY)
  })
})
