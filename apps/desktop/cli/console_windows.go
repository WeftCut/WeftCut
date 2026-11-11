//go:build windows

package main

import (
	"os"
	"syscall"
)

// attachParentProcess is ATTACH_PARENT_PROCESS (wincon.h): (DWORD)-1.
const attachParentProcess = 0xFFFFFFFF

// attachConsole gives a run from a terminal somewhere to print.
//
// LANDMINE: the Windows binary is linked for the GUI subsystem
// (scripts/build-weftcut-cli.mjs, -H=windowsgui). A console program started by
// a parent that has no console gets a new, visible console window from
// Windows unless that parent asked for none, and not every MCP client asks:
// measured, a console-less node.exe spawning with default flags showed a
// terminal window for as long as the server ran. A GUI program is never given
// one. The price is that it is not given its parent's console either, so it
// takes it here: a terminal's handles when no pipe or file was passed in.
func attachConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	if attached, _, _ := kernel32.NewProc("AttachConsole").Call(uintptr(attachParentProcess)); attached == 0 {
		// No console to join: a client's pipes are all there is.
		return
	}
	if !usable(os.Stdout) {
		if console, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
			os.Stdout = console
		}
	}
	if !usable(os.Stderr) {
		if console, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
			os.Stderr = console
		}
	}
}

// usable reports whether f is a handle the parent passed in. A GUI program
// started without redirection has none.
func usable(f *os.File) bool {
	kind, err := syscall.GetFileType(syscall.Handle(f.Fd()))
	return err == nil && kind != syscall.FILE_TYPE_UNKNOWN
}
