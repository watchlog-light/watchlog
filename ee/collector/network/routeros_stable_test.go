// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// A seeded certificate is the same after a restart (the demo's netsim), and another seed's isn't.
func TestStableCert(t *testing.T) {
	start := time.Now()
	a, err := netsim.Edge(start).StableCert("demo")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := netsim.Edge(start).StableCert("demo")
	c, _ := netsim.Edge(start).StableCert("other")
	if a == "" || a != b || a == c {
		t.Fatalf("pins %s %s %s", a, b, c)
	}
}
