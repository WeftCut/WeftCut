import { describe, expect, it } from 'vitest'
import type { ShortcutDetails } from 'electron'
import { DEV_WINDOWS_IDENTITY, PACKAGED_WINDOWS_IDENTITY } from './appIdentity'
import { installWindowsNotifications, type WindowsNotificationHost } from './windowsNotifications'

const LNK = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\WeftCut.lnk'
const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\WeftCut\\WeftCut.exe'

/// A host that records every call in order and keeps one shortcut on disk.
function fakeHost(shortcut: ShortcutDetails | null, opts: { writeFails?: boolean } = {}) {
  const log: string[] = []
  let activation: (() => void) | null = null
  let lnk = shortcut
  const host: WindowsNotificationHost = {
    setAppUserModelId: (id) => log.push(`aumid ${id}`),
    setToastActivatorCLSID: (id) => log.push(`clsid ${id}`),
    shortcutExists: () => lnk !== null,
    readShortcutLink: () => {
      if (!lnk) throw new Error('no shortcut')
      return { ...lnk }
    },
    updateShortcutLink: (_path, details) => {
      log.push(`update ${details.toastActivatorClsid}`)
      if (opts.writeFails) return false
      lnk = { ...lnk!, ...details }
      return true
    },
    handleActivation: (cb) => {
      activation = cb
      log.push('handleActivation')
    },
    registerActivator: () => log.push('registerActivator'),
  }
  return { host, log, shortcut: () => lnk, click: () => activation?.() }
}

const packaged = (onActivation = () => {}) => ({ identity: PACKAGED_WINDOWS_IDENTITY, installerShortcut: LNK, onActivation })

describe('installWindowsNotifications', () => {
  it('stamps the installer shortcut with the app CLSID before Electron registers the activator', () => {
    const f = fakeHost({ target: EXE, description: 'WeftCut video editor desktop app' })
    expect(installWindowsNotifications(f.host, packaged())).toBe('stamped')
    expect(f.log.indexOf(`update ${PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid}`)).toBeLessThan(f.log.indexOf('registerActivator'))
    expect(f.log.indexOf(`clsid ${PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid}`)).toBeLessThan(f.log.indexOf('registerActivator'))
    expect(f.shortcut()).toMatchObject({ target: EXE, description: 'WeftCut video editor desktop app', toastActivatorClsid: PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid })
  })

  it('replaces a CLSID Electron generated on an earlier run', () => {
    const f = fakeHost({ target: EXE, toastActivatorClsid: '{922BE7BE-C794-4A8D-A2F7-FEDBF908BBA7}' })
    expect(installWindowsNotifications(f.host, packaged())).toBe('stamped')
    expect(f.shortcut()?.toastActivatorClsid).toBe(PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid)
  })

  it('leaves a shortcut that already carries the app CLSID untouched, whatever its case', () => {
    const f = fakeHost({ target: EXE, toastActivatorClsid: PACKAGED_WINDOWS_IDENTITY.toastActivatorClsid.toLowerCase() })
    expect(installWindowsNotifications(f.host, packaged())).toBe('current')
    expect(f.log.some((l) => l.startsWith('update'))).toBe(false)
  })

  it('never creates a shortcut the installer did not leave', () => {
    const f = fakeHost(null)
    expect(installWindowsNotifications(f.host, packaged())).toBe('absent')
    expect(f.log.some((l) => l.startsWith('update'))).toBe(false)
    expect(f.log).toContain('registerActivator')
  })

  it('still registers the activator when the shortcut cannot be written', () => {
    const f = fakeHost({ target: EXE }, { writeFails: true })
    expect(installWindowsNotifications(f.host, packaged())).toBe('failed')
    expect(f.log).toContain('registerActivator')
  })

  it('gives an unpackaged run the dev identity and leaves shortcuts alone', () => {
    const f = fakeHost({ target: EXE })
    expect(installWindowsNotifications(f.host, { identity: DEV_WINDOWS_IDENTITY, installerShortcut: null, onActivation: () => {} })).toBe('none')
    expect(f.log).toEqual([
      `aumid ${DEV_WINDOWS_IDENTITY.appUserModelId}`,
      `clsid ${DEV_WINDOWS_IDENTITY.toastActivatorClsid}`,
      'handleActivation',
      'registerActivator',
    ])
  })

  it('hands every activation to the caller', () => {
    let clicks = 0
    const f = fakeHost({ target: EXE })
    installWindowsNotifications(f.host, packaged(() => clicks++))
    f.click()
    f.click()
    expect(clicks).toBe(2)
  })
})
