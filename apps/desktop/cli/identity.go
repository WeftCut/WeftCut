package main

// The app this binary belongs to, as identity.json names it: the one home of
// those names, which the app and the build scripts read too.

import (
	_ "embed"
	"encoding/json"
)

//go:embed identity.json
var identityJSON []byte

// appIdentity is identity.json.
type appIdentity struct {
	// BundleID is the macOS bundle identifier (electron-builder.yml appId).
	BundleID string `json:"bundleId"`
	// ProductName names the profile directory Electron gives the app, and
	// its executable.
	ProductName string `json:"productName"`
	// PackageName is package.json's name, which Electron named the profile
	// directory after before productName was set. A slash in it is a
	// subdirectory.
	PackageName string `json:"packageName"`
	// BinaryName is this binary's file name, without .exe.
	BinaryName string `json:"binaryName"`
}

var product = parseIdentity(identityJSON)

// parseIdentity reads identity.json. The file is part of the build, so one
// that does not parse stops the binary at its start rather than letting it
// look for an app under empty names.
func parseIdentity(data []byte) appIdentity {
	var id appIdentity
	if err := json.Unmarshal(data, &id); err != nil {
		panic("identity.json: " + err.Error())
	}
	if id.BundleID == "" || id.ProductName == "" || id.PackageName == "" || id.BinaryName == "" {
		panic("identity.json: a name is missing")
	}
	return id
}
