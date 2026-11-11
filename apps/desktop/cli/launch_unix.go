//go:build unix

package main

import "syscall"

// detached puts the app in a session of its own: a signal to the client's
// process group, or its terminal closing, does not reach it.
func detached() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
