// SPDX-License-Identifier: AGPL-3.0-only

package exits

import "testing"

func TestFeedTwoConsumers(t *testing.T) {
	f := NewFeed()
	f.Add(Exit{PID: 10, Cgroup: 7, Status: 3})
	f.Add(Exit{PID: 11, Cgroup: 8, Signal: 9, OOM: true})
	if got := f.TakeByPID(); len(got) != 2 || got[10].Kind() != "error" || got[11].Kind() != "signal" {
		t.Fatalf("by pid: %+v", got)
	}
	if got := f.TakeAll(); len(got) != 2 || got[0].Code() != 3 || got[1].Code() != 137 {
		t.Fatalf("all: %+v", got)
	}
	if len(f.TakeByPID()) != 0 || len(f.TakeAll()) != 0 {
		t.Fatal("taken once")
	}
	for i := 0; i < Max+5; i++ {
		f.Add(Exit{PID: i})
	}
	if f.Dropped != 10 {
		t.Fatalf("dropped %d", f.Dropped)
	}
}
