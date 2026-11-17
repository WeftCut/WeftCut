export type UpdateStatus = {
  phase: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'restarting' | 'error'
  version?: string
  percent?: number
  /** macOS: Squirrel has staged this update, and it installs at the next exit
   *  whatever the preferences now say (main/updates.ts MacInstall). */
  committed?: boolean
  /** Why an offered update cannot be downloaded: `location`, a macOS copy
   *  that cannot replace itself where it runs. */
  reason?: 'location'
}

export type UpdateRestartResult = 'restarting' | 'not-ready' | 'save-failed'
export type UpdateDownloadResult = 'ready' | 'not-ready' | 'download-failed'
/** null means a normal launch; { path: null } restores the start screen. */
export type UpdateResume = { path: string | null } | null
