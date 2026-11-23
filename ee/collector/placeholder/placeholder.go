// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

// Package placeholder is the placeholder Enterprise collector package (ADR-232): it
// registers itself, which proves the build tag and the go.work. The network package
// replaces it.
package placeholder

import "github.com/watchlog-light/watchlog/agent/ext"

func init() {
	ext.Register(ext.Module{Name: "placeholder", Feature: "network"})
}
