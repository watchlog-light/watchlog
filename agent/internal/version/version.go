// SPDX-License-Identifier: AGPL-3.0-only

// Package version holds build metadata injected at link time via -ldflags.
package version

import (
	"fmt"
	"runtime"
)

// Set with -ldflags "-X github.com/watchlog-light/watchlog/agent/internal/version.Version=...".
var (
	Version = "dev"
	Commit  = "unknown"
)

// String returns a single human-readable version line.
func String() string {
	return fmt.Sprintf("%s %s (commit %s, %s, %s/%s)",
		Name, Version, Commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}

// Name is the binary's name in String; the cluster-agent sets its own (ADR-048).
var Name = "watchlog-agent"
