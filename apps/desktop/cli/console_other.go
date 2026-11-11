//go:build !windows

package main

// attachConsole is Windows' concern (console_windows.go): elsewhere a program
// has the terminal it was started from.
func attachConsole() {}
