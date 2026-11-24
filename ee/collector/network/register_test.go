// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"slices"
	"testing"

	"github.com/watchlog-light/watchlog/agent/ext"
)

func TestRegistersItself(t *testing.T) {
	if !slices.Contains(ext.Names(), "network") {
		t.Fatalf("ext.Names() = %v", ext.Names())
	}
}
