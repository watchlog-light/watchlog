// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import "testing"

func TestCounters(t *testing.T) {
	c := NewCounters()
	// The first value is the total.
	if got := c.Add("in", 1000, 64, false); got != 1000 {
		t.Fatalf("first = %v", got)
	}
	if got := c.Add("in", 1500, 64, false); got != 1500 {
		t.Fatalf("grew = %v", got)
	}
	// A 32-bit counter near the top wraps: what it counted across the wrap is added.
	c.Add("in32", 4_294_967_000, 32, false)
	if got := c.Add("in32", 200, 32, false); got != 4_294_967_000+296+200 {
		t.Fatalf("wrap = %v, want %v", got, 4_294_967_000+296+200)
	}
	// A 64-bit counter that goes back (cleared): starts over from the new value.
	if got := c.Add("in", 300, 64, false); got != 1800 {
		t.Fatalf("reset = %v, want 1800", got)
	}
	// A 32-bit counter low in its range that goes back isn't a wrap: a reset.
	c.Add("low32", 5000, 32, false)
	if got := c.Add("low32", 100, 32, false); got != 5100 {
		t.Fatalf("low reset = %v", got)
	}
	// The device rebooted (uptime went back): every counter starts over, even upward.
	if got := c.Add("in", 900, 64, true); got != 2700 {
		t.Fatalf("reboot = %v, want 2700", got)
	}
	c.Forget(func(k string) bool { return k == "in" })
	if _, ok := c.last["in32"]; ok {
		t.Fatal("forgotten counters stay")
	}
}
