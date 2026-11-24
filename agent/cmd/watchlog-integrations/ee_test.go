// SPDX-License-Identifier: AGPL-3.0-only

//go:build ee

package main

import (
	"slices"
	"testing"

	"github.com/watchlog-light/watchlog/agent/ext"
)

// Built with the tag, the collector carries ee/'s packages.
func TestEnterprisePackagesRegistered(t *testing.T) {
	if !slices.Contains(ext.Names(), "network") {
		t.Fatalf("ext.Names() = %v, want network", ext.Names())
	}
}
