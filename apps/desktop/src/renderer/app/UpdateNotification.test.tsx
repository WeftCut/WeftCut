// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import { UpdateNotification } from './UpdateNotification'
import { UpdateDialog } from './UpdateDialog'
import { useAppSettingsStore } from '../settings/appSettingsStore'

afterEach(cleanup)

function setup(autoInstall = true) {
  useAppSettingsStore.setState(state => ({ settings: { ...state.settings, auto_install_updates_on_quit: autoInstall } }))
  const ready = { phase: 'ready', version: '1.2.0' }
  const restart = vi.fn().mockResolvedValue('restarting')
  const api = { updates: { status: vi.fn().mockResolvedValue(ready), check: vi.fn().mockResolvedValue(ready), restart } }
  Object.assign(window, { api })
  return api.updates
}

describe('update actions', () => {
  it('announces a ready update without a modal and dismisses without changing the exit preference', async () => {
    const { restart } = setup()
    render(<UpdateNotification />)
    await screen.findByRole('complementary', { name: 'A new version is available' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
    expect(useAppSettingsStore.getState().settings.auto_install_updates_on_quit).toBe(true)
  })

  it('restarts once with a blocking saving state, leaving an opt-out unchanged', async () => {
    const { restart } = setup(false)
    render(<UpdateNotification />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update and restart app' }))
    await screen.findByRole('dialog', { name: 'Saving and restarting…' })
    expect(restart).toHaveBeenCalledOnce()
    expect(useAppSettingsStore.getState().settings.auto_install_updates_on_quit).toBe(false)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('keeps the update available for retry if saving fails', async () => {
    const { restart } = setup()
    restart.mockResolvedValue('save-failed')
    render(<UpdateNotification />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update and restart app' }))
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByRole('button', { name: 'Update and restart app' }) as HTMLButtonElement).disabled).toBe(false)
    expect(useAppSettingsStore.getState().settings.auto_install_updates_on_quit).toBe(true)
  })

  it('offers the same actions from Help after dismissing the notification', async () => {
    setup(false)
    const onClose = vi.fn()
    render(<UpdateDialog onClose={onClose} />)
    await screen.findByRole('button', { name: 'Update and restart app' })
    expect(screen.getByText(/You can return to the update from the Help menu/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
