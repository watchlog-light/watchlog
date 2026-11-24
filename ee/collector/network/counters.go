// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import "math"

// Counters turns a device's raw counters into totals that only grow, as VictoriaMetrics'
// rate() expects (ADR-233): a 32-bit counter that wraps adds what it counted across the wrap;
// a counter that goes back without a wrap (the device rebooted, the counter was cleared)
// starts over from its new value. 64-bit counters (ifHCInOctets) are only reset, never wrap
// in practice.
type Counters struct {
	last  map[string]float64
	total map[string]float64
}

// NewCounters makes an empty tracker.
func NewCounters() *Counters {
	return &Counters{last: map[string]float64{}, total: map[string]float64{}}
}

const wrap32 = float64(math.MaxUint32) + 1

// Add records a raw value of a counter (bits is 32 or 64) and returns its running total.
// reset says the device rebooted since the last poll: every counter starts over.
func (c *Counters) Add(key string, raw float64, bits int, reset bool) float64 {
	prev, seen := c.last[key]
	c.last[key] = raw
	if !seen {
		c.total[key] = raw
		return raw
	}
	var delta float64
	switch {
	case reset:
		delta = raw
	case raw >= prev:
		delta = raw - prev
	case bits == 32 && prev > wrap32/2:
		// Wrapped: what it counted to the top, then from zero.
		delta = wrap32 - prev + raw
	default:
		// Went back: cleared, or a counter the device restarted.
		delta = raw
	}
	c.total[key] += delta
	return c.total[key]
}

// Forget drops counters no longer seen (a port that went away).
func (c *Counters) Forget(keep func(key string) bool) {
	for k := range c.last {
		if !keep(k) {
			delete(c.last, k)
			delete(c.total, k)
		}
	}
}
