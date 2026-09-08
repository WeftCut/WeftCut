; WeftCut custom NSIS include.
;
; electron-builder auto-detects ${buildResources}/installer.nsh (here build/) and
; !includes it into the generated installer — no `nsis.include` key is needed
; (see app-builder-lib NsisTarget.getResource(undefined, "installer.nsh")). It
; contributes two macros: customInstall (taskbar AUMID re-stamp, below) and
; customHeader (a per-user install guard against protected system folders, at the
; end of this file). This file MUST begin with a UTF-8 BOM so makensis reads the
; guard's Chinese message as UTF-8: electron-builder's bundled NSIS (3.0.4.1) is
; too old for the `!encoding` directive (it aborts with `Invalid command:
; "!encoding"`), and an !included file inherits nothing from the UTF-8 stdin
; parent — without the BOM its bytes are read as the system ANSI codepage and the
; Chinese turns to mojibake. Keep the BOM if you re-save this file.
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

; ---------------------------------------------------------------------------
; customHeader: block a per-user install from targeting a protected system
; folder (Program Files / Windows), with a clear reason instead of a dead
; "Next" button.
;
; WHY: the assisted installer runs UNELEVATED for a per-user ("only for me")
; install — `RequestExecutionLevel user`. With allowToChangeInstallationDirectory
; on, the directory page will happily accept C:\Program Files\WeftCut, but a
; non-admin process cannot create or write there. The stock template performs NO
; writability check, so extraction fails half-way and the user is shown the
; misleading "WeftCut cannot be closed" retry loop (extractAppPackage.nsh) and
; then a raw "cannot write file" error — with nothing pointing at the real cause
; (wrong install location for an unelevated install).
;
; .onVerifyInstDir is NSIS's native per-change directory hook and the only
; reliable one here: assistedInstaller.nsh's own comment notes the directory
; page's LEAVE callback runs before $INSTDIR is committed, so a leave-time check
; is unreliable. Returning via Abort greys out Next; a one-shot MessageBox —
; gated on the transition INTO an invalid path so it does not fire on every
; keystroke — states exactly why, naming the folder and the fix.
;
; WHERE THIS COMPILES: electron-builder emits our whole installer.nsh into its
; shared HEADER, which precedes the template's own includes — so LogicLib,
; UAC.nsh and `Var installMode` are NOT yet defined at file scope. The template
; expands customHeader at installer.nsi (right after multiUser.nsh, before
; .onInit), where all of them ARE defined; that is why the guard lives in a
; macro, exactly like customInstall above, and not as a bare top-level Function.
;
; An all-users install runs ELEVATED (UAC on the mode page), so $installMode is
; "all" and Program Files is its intended target — that lane is never blocked.
; The mode page always precedes the directory page, so $installMode is set by
; the time .onVerifyInstDir first fires.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; "1" once the explanation has been shown for the current invalid path, so
    ; the modal is not re-shown while the path stays invalid; reset to "0" on any
    ; valid path (or all-users mode) so a later re-entry explains itself again.
    Var weftcutSysDirWarned

    Function .onVerifyInstDir
      ; Per-machine (elevated) installs may write under Program Files — leave them.
      ${If} $installMode == "all"
        StrCpy $weftcutSysDirWarned "0"
        Return
      ${EndIf}

      ; $R9 = "1" if $INSTDIR sits under a protected root. $R7/$R8 are scratch;
      ; .onVerifyInstDir is a leaf callback, so borrowing these registers without
      ; save/restore is safe (nothing reads them back after it returns).
      StrCpy $R9 "0"

      ; Prefix-match $INSTDIR against each protected root: copy the first
      ; StrLen(root) characters of $INSTDIR and compare (LogicLib == is a
      ; case-insensitive StrCmp, correct for Windows paths). On a 64-bit host the
      ; 32-bit stub sees $PROGRAMFILES = "...\Program Files (x86)" and
      ; $PROGRAMFILES64 = "...\Program Files", so both must be checked.
      StrLen $R8 "$PROGRAMFILES64"
      StrCpy $R7 "$INSTDIR" $R8
      ${If} $R7 == "$PROGRAMFILES64"
        StrCpy $R9 "1"
      ${EndIf}

      StrLen $R8 "$PROGRAMFILES"
      StrCpy $R7 "$INSTDIR" $R8
      ${If} $R7 == "$PROGRAMFILES"
        StrCpy $R9 "1"
      ${EndIf}

      StrLen $R8 "$WINDIR"
      StrCpy $R7 "$INSTDIR" $R8
      ${If} $R7 == "$WINDIR"
        StrCpy $R9 "1"
      ${EndIf}

      ${If} $R9 == "1"
        ${IfNot} $weftcutSysDirWarned == "1"
          StrCpy $weftcutSysDirWarned "1"
          MessageBox MB_OK|MB_ICONEXCLAMATION "“$INSTDIR”位于受保护的系统目录（Program Files 或 Windows）。$\n当前为“仅为我安装”，没有管理员权限，无法写入该位置。$\n$\n请改用默认安装目录，或点击“上一步”并选择“为所有用户安装（需要管理员权限）”。$\n$\nThis folder is a protected system location (Program Files or Windows). A per-user install cannot write here without administrator rights. Choose a different folder, or go Back and select install for all users."
        ${EndIf}
        Abort ; keeps Next disabled while the path is invalid
      ${Else}
        StrCpy $weftcutSysDirWarned "0"
      ${EndIf}
    FunctionEnd
  !endif
!macroend
