//go:build windows

package main

import "syscall"

// Process creation flags (winbase.h); the syscall package names only the second.
const (
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200
)

// detached gives the app no console and a process group of its own: the
// client's console closing, or a Ctrl-C in it, does not reach it.
func detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
}
