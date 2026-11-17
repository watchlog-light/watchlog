// SPDX-License-Identifier: AGPL-3.0-only

// Package config parses agent configuration (SPEC §6.2, §6.7).
package config

import "fmt"

// Mode selects what the agent collects (SPEC §6.2).
type Mode string

const (
	ModeNode    Mode = "node"
	ModeCluster Mode = "cluster"
	// ModeServer is a server's agent (ADR-207, ADR-208): services, process groups and
	// containers. Its value is "docker", the name 0.8 used: the heartbeat's mode on the
	// wire stays the one every backend accepts.
	ModeServer Mode = "docker"
	// ModeDocker is ModeServer's 0.8 name.
	ModeDocker = ModeServer
)

// ParseMode validates the --mode flag value: node, cluster, server, or docker (an alias of
// server, so an old install's flag keeps working).
func ParseMode(s string) (Mode, error) {
	switch s {
	case "node":
		return ModeNode, nil
	case "cluster":
		return ModeCluster, nil
	case "server", "docker":
		return ModeServer, nil
	default:
		return "", fmt.Errorf("invalid mode %q: must be one of node, cluster, server (or docker)", s)
	}
}
