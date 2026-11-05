// SPDX-License-Identifier: AGPL-3.0-only

// Package config parses agent configuration (SPEC §6.2, §6.7).
package config

import "fmt"

// Mode selects what the agent collects (SPEC §6.2).
type Mode string

const (
	ModeNode    Mode = "node"
	ModeCluster Mode = "cluster"
	ModeDocker  Mode = "docker"
)

// ParseMode validates the --mode flag value.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(s); m {
	case ModeNode, ModeCluster, ModeDocker:
		return m, nil
	default:
		return "", fmt.Errorf("invalid mode %q: must be one of node, cluster, docker", s)
	}
}
