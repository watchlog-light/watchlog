// SPDX-License-Identifier: AGPL-3.0-only

//go:build ee

// The Enterprise packages (ee/collector, ADR-232), in the released collector only: it is
// built with `-tags ee` and a go.work that joins ee/collector (scripts/ee-go.sh). Without the
// tag this file isn't compiled, and the collector builds and tests with ee/ deleted.
package main

import (
	_ "github.com/watchlog-light/watchlog/ee/collector/placeholder"
)
