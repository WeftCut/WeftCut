//go:build windows

package main

import (
	"os"
	"syscall"
)

// attachParentProcess is ATTACH_PARENT_PROCESS (wincon.h): (DWORD)-1.
const attachParentProcess = 0xFFFFFFFF

// replaced holds the files attachConsole took out of os.Stdout and os.Stderr.
// A dropped *os.File closes its handle when it is collected, and a rewrap
// shares that handle.
var replaced []*os.File

// attachConsole gives a run from a terminal somewhere to print.
//
// LANDMINE: the Windows binary is linked for the GUI subsystem
// (scripts/build-weftcut-cli.mjs, -H=windowsgui). A console program started by
// a parent that has no console gets a new, visible console window from
// Windows unless that parent asked for none, and not every MCP client asks:
// measured, a console-less node.exe spawning with default flags showed a
// terminal window for as long as the server ran. A GUI program is never given
// one. The price is that it is not given its parent's console either, so it
// takes it here.
func attachConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	if attached, _, _ := kernel32.NewProc("AttachConsole").Call(uintptr(attachParentProcess)); attached == 0 {
		// No console to join: a client's pipes are all there is.
		return
	}
	os.Stdout = onConsole(os.Stdout, "/dev/stdout")
	os.Stderr = onConsole(os.Stderr, "/dev/stderr")
}

// onConsole is f as it should be now that the process has a console.
//
// A pipe or a file the parent passed in stays as it is. No handle at all (a
// GUI program started from a prompt has none) becomes the console. A console
// handle the parent passed in (Git Bash does) is wrapped again.
//
// LANDMINE: package os decides once, when it wraps a handle, whether it is a
// console, by asking for its console mode; only then does it write UTF-16.
// At start-up this process had no console, so every such question failed and
// text went out as raw UTF-8 bytes in the console's code page: measured, an
// em dash printed as three characters. The question needs read access too,
// hence CONOUT$ opened read-write.
func onConsole(f *os.File, name string) *os.File {
	handle := syscall.Handle(f.Fd())
	kind, err := syscall.GetFileType(handle)
	if err != nil || kind == syscall.FILE_TYPE_UNKNOWN {
		if console, err := os.OpenFile("CONOUT$", os.O_RDWR, 0); err == nil {
			return console
		}
		return f
	}
	var mode uint32
	if kind != syscall.FILE_TYPE_CHAR || syscall.GetConsoleMode(handle, &mode) != nil {
		return f
	}
	if rewrapped := os.NewFile(uintptr(handle), name); rewrapped != nil {
		replaced = append(replaced, f)
		return rewrapped
	}
	return f
}
