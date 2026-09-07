; WeftCut custom NSIS include.
;
; electron-builder auto-detects ${buildResources}/installer.nsh (here build/) and
; !includes it into the generated installer — no `nsis.include` key is needed
; (see app-builder-lib NsisTarget.getResource(undefined, "installer.nsh")). The
; only thing this file contributes is the customInstall macro below.
;
; WHY: re-stamp the Windows taskbar identity (AppUserModelID) onto the app's
; shortcuts on EVERY install and in-place update.
;
; electron-builder's stock addStartMenuLink / addDesktopLink macros call
; WinShell::SetLnkAUMI only when they (re)create or RENAME a shortcut. On a
; keepShortcuts in-place update where the shortcut name is unchanged
; ($oldStartMenuLink == $newStartMenuLink), NEITHER branch runs — so after
; electron-updater rewrites the exe, the existing shortcut can be left carrying a
; stale or missing AUMID. Windows then cannot resolve the per-AUMID taskbar app
; record and paints a blank/generic icon, even though the exe itself embeds the
; correct multi-resolution icon. Known issue: openchamber/openchamber#2175 (same
; dev.<app>.desktop naming, same symptom); electron-builder #776 / #1190 / #810.
;
; customInstall is inserted in installSection.nsh AFTER `!insertmacro setLinkVars`
; and after addStartMenuLink/addDesktopLink, so $newStartMenuLink / $newDesktopLink
; are populated and the shortcuts (if any) already exist on disk. We re-assert the
; AUMID on whichever shortcuts exist — never resurrecting one the user deleted —
; and nudge the shell to rebuild its association/icon cache from the fresh stamp.
;
; ${APP_ID} is electron-builder's symbol for electron-builder.yml `appId`; the
; runtime keeps the same value in src/main/appIdentity.ts (asserted equal by
; appIdentity.test.ts). The WinShell::SetLnkAUMI call shape mirrors the stock
; macros in app-builder-lib templates/nsis/include/installer.nsh (no stack Pop).

!macro customInstall
  ${if} ${FileExists} "$newStartMenuLink"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ClearErrors
  ${endif}
  ${if} ${FileExists} "$newDesktopLink"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ClearErrors
  ${endif}
  ; SHCNE_ASSOCCHANGED (0x08000000): tell the shell to re-read icon/identity
  ; associations, so the taskbar record is rebuilt from the freshly-stamped
  ; shortcut rather than from a cache captured mid-update. Same call the stock
  ; addDesktopLink macro already makes.
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
