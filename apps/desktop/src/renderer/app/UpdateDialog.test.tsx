// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsPatch } from '../../shared/app-settings'
import '../i18n'
import { UpdateDialog } from './UpdateDialog'
import { UpdateButton } from './UpdateButton'
import { UpdateIndicator } from './UpdateIndicator'
import { useAppSettingsStore } from '../settings/appSettingsStore'

const mocks = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock('../ipc', async importOriginal => ({ ...await importOriginal<object>(), appSettingsSet: mocks.set }))

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

function setup(autoInstall = true, skipped?: string) {
  useAppSettingsStore.setState(state => {
    const { skipped_update_version: _, ...settings } = state.settings
    return { settings: { ...settings, auto_install_updates_on_quit: autoInstall, ...(skipped ? { skipped_update_version: skipped } : {}) } }
  })
  mocks.set.mockReset().mockImplementation(async (patch: AppSettingsPatch) => {
    const { skipped_update_version: _, ...settings } = useAppSettingsStore.getState().settings
    return { ...settings, ...(patch.skipped_update_version ? { skipped_update_version: patch.skipped_update_version } : {}) }
  })
  const ready = { phase: 'ready', version: '1.2.0' }
  const restart = vi.fn().mockResolvedValue('restarting')
  const download = vi.fn().mockResolvedValue('ready')
  const api = { updates: { status: vi.fn().mockResolvedValue(ready), check: vi.fn().mockResolvedValue(ready), restart, download } }
  Object.assign(window, { api })
  return api.updates
}

const skippedVersion = () => useAppSettingsStore.getState().settings.skipped_update_version

describe('update dialog', () => {
  it('restarts once with a blocking saving state, leaving an opt-out unchanged', async () => {
    const { restart } = setup(false)
    render(<UpdateDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update and restart app' }))
    await screen.findByRole('dialog', { name: 'Saving and restarting…' })
    expect(restart).toHaveBeenCalledOnce()
    expect(useAppSettingsStore.getState().settings.auto_install_updates_on_quit).toBe(false)
  })

  it('keeps the update available for retry if saving fails', async () => {
    const { restart } = setup()
    restart.mockResolvedValue('save-failed')
    render(<UpdateDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update and restart app' }))
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Saving and restarting…' })).toBeNull())
    expect((screen.getByRole('button', { name: 'Update and restart app' }) as HTMLButtonElement).disabled).toBe(false)
    expect(useAppSettingsStore.getState().settings.auto_install_updates_on_quit).toBe(true)
  })

  it('closes on Later without changing any preference', async () => {
    setup(false)
    const onClose = vi.fn()
    render(<UpdateDialog onClose={onClose} />)
    await screen.findByRole('button', { name: 'Update and restart app' })
    expect(screen.getByText(/You can return to the update from the Help menu/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(mocks.set).not.toHaveBeenCalled()
  })

  it('offers an explicit download in manual mode and opening the dialog does not download', async () => {
    const api = setup(false)
    api.check.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    render(<UpdateDialog onClose={vi.fn()} />)
    const download = await screen.findByRole('button', { name: 'Download and install' })
    expect(screen.getByText(/It will only download when you choose/)).toBeTruthy()
    expect(api.download).not.toHaveBeenCalled()
    fireEvent.click(download)
    await waitFor(() => expect(api.download).toHaveBeenCalledOnce())
    expect(api.restart).toHaveBeenCalledOnce()
    await screen.findByRole('dialog', { name: 'Saving and restarting…' })
    expect(useAppSettingsStore.getState().settings.auto_install_updates_on_quit).toBe(false)
  })

  it('keeps a manual download in the dialog through progress and failure, then allows retry', async () => {
    const api = setup(false)
    api.check.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    api.status.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    let fail!: (result: string) => void
    api.download.mockImplementation(() => new Promise(resolve => { fail = resolve }))
    render(<UpdateDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download and install' }))
    api.status.mockResolvedValue({ phase: 'downloading', version: '1.2.0', percent: 25 })
    await screen.findByText('Downloading 1.2.0… 25%', {}, { timeout: 2000 })
    api.status.mockResolvedValue({ phase: 'error', version: '1.2.0' })
    fail('download-failed')
    expect((await screen.findByRole('alert')).textContent).toContain('Could not download the update')
    const retry = await screen.findByRole('button', { name: 'Download and install' }, { timeout: 2000 })
    expect((retry as HTMLButtonElement).disabled).toBe(false)
    expect(api.download).toHaveBeenCalledOnce()
  })

  it('skips the offered version and closes', async () => {
    const api = setup(false)
    api.check.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    const onClose = vi.fn()
    render(<UpdateDialog onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this version' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ skipped_update_version: '1.2.0' })
    await waitFor(() => expect(skippedVersion()).toBe('1.2.0'))
    expect(api.download).not.toHaveBeenCalled()
  })

  it('offers a skipped version from Help as usual, and downloading it un-skips first', async () => {
    const api = setup(false, '1.2.0')
    api.check.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    render(<UpdateDialog onClose={vi.fn()} />)
    await screen.findByText(/1\.2\.0 is available/)
    expect(screen.queryByText(/skipped/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download and install' }))
    await waitFor(() => expect(api.download).toHaveBeenCalledOnce())
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ skipped_update_version: '' })
    expect(mocks.set.mock.invocationCallOrder[0]!).toBeLessThan(api.download.mock.invocationCallOrder[0]!)
    expect(skippedVersion()).toBeUndefined()
  })

  it('keeps the releases link instead of skip when a known version failed', async () => {
    const api = setup(false)
    api.check.mockResolvedValue({ phase: 'error', version: '1.2.0' })
    render(<UpdateDialog onClose={vi.fn()} />)
    await screen.findByRole('button', { name: 'Download and install' })
    expect(screen.getByRole('button', { name: 'View Releases' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Skip this version' })).toBeNull()
  })
})

describe('start-screen update icon', () => {
  it('reuses the update dialog without downloading', async () => {
    const api = setup(false)
    api.status.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    api.check.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    render(<UpdateButton />)
    fireEvent.click(await screen.findByRole('button', { name: 'A new version is available' }))
    await screen.findByRole('dialog', { name: 'A new version is available' })
    expect(screen.getByRole('button', { name: 'Download and install' })).toBeTruthy()
    expect(api.download).not.toHaveBeenCalled()
  })

  it.each(['idle', 'checking', 'current', 'disabled', 'error'])('keeps the dev check icon visible in the %s state', async phase => {
    vi.stubEnv('DEV', true)
    const api = setup()
    api.status.mockResolvedValue({ phase })
    render(<UpdateButton />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    const button = screen.getByRole('button', { name: 'Check for Updates…' })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).toBeTruthy()
    expect(api.check).not.toHaveBeenCalled()
    expect(api.download).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'A new version is available' })).toBeNull()
  })

  it.each(['idle', 'checking', 'current', 'disabled', 'error'])('hides the release check icon without a known update in the %s state', async phase => {
    vi.stubEnv('DEV', false)
    const api = setup()
    api.status.mockResolvedValue({ phase })
    render(<UpdateButton />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the release icon when a new version is available', async () => {
    vi.stubEnv('DEV', false)
    const api = setup(false)
    api.status.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    render(<UpdateButton />)
    const button = await screen.findByRole('button', { name: 'A new version is available' })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).toBeTruthy()
    expect(api.check).not.toHaveBeenCalled()
    expect(api.download).not.toHaveBeenCalled()
  })

  it('hides the release icon for a skipped version but not for a newer one', async () => {
    vi.stubEnv('DEV', false)
    const api = setup(false, '1.2.0')
    api.status.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    render(<UpdateButton />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
    api.status.mockResolvedValue({ phase: 'available', version: '1.3.0' })
    await screen.findByRole('button', { name: 'A new version is available' }, { timeout: 2000 })
  })
})

describe('status-bar update icon', () => {
  it('stays out of the bar without an offered update', async () => {
    const api = setup()
    api.status.mockResolvedValue({ phase: 'current' })
    render(<UpdateIndicator />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    [{ phase: 'available', version: '1.2.0' }, '1.2.0 is available'],
    [{ phase: 'downloading', version: '1.2.0', percent: 42 }, 'Downloading 1.2.0… 42%'],
    [{ phase: 'ready', version: '1.2.0' }, '1.2.0 is ready to install'],
    [{ phase: 'error', version: '1.2.0' }, 'Could not download 1.2.0'],
  ])('keeps a fixed label and is named for the %o phase', async (status, name) => {
    const api = setup()
    api.status.mockResolvedValue(status)
    render(<UpdateIndicator />)
    const button = await screen.findByRole('button', { name })
    expect(button.textContent).toBe('Update available')
    expect(button.getAttribute('title')).toBe(name)
    expect(!!button.querySelector('.status-bar-update-ring')).toBe(status.phase === 'downloading')
    expect(api.check).not.toHaveBeenCalled()
  })

  it('opens the update dialog and hides once the version is skipped there', async () => {
    const api = setup(false)
    api.status.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    api.check.mockResolvedValue({ phase: 'available', version: '1.2.0' })
    render(<UpdateIndicator />)
    fireEvent.click(await screen.findByRole('button', { name: '1.2.0 is available' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this version' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('button', { name: '1.2.0 is available' })).toBeNull())
  })
})
