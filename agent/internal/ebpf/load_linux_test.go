// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Under a high rate of short connections the counters must match what the client saw
// (WATCHLOG_EBPF_LOAD=1, same container settings as TestFlowsInAContainer).
func TestCountsMatchTheClientUnderLoad(t *testing.T) {
	if os.Getenv("WATCHLOG_EBPF_LOAD") != "1" {
		t.Skip("set WATCHLOG_EBPF_LOAD=1")
	}
	f, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	var ok, failed atomic.Int64
	var wg sync.WaitGroup
	sem := make(chan struct{}, 64)
	for range 5000 {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			c, err := net.Dial("tcp4", ln.Addr().String())
			if err != nil {
				failed.Add(1)
				return
			}
			_ = c.Close()
			ok.Add(1)
		}()
	}
	wg.Wait()
	flows, _ := f.Drain()
	var got Flow
	for _, fl := range flows {
		if fl.Port == port {
			got.Connects += fl.Connects
			got.Failures += fl.Failures
			got.Established += fl.Established
		}
	}
	t.Logf("client ok=%d failed=%d; kernel connects=%d established=%d failures=%d",
		ok.Load(), failed.Load(), got.Connects, got.Established, got.Failures)
	if int64(got.Established) != ok.Load() || int64(got.Failures) != failed.Load() {
		t.Errorf("counters differ from the client")
	}
}

// Sustained: about 1,000 short connections a second for 70 s, the client closing first
// (its sockets wait in TIME_WAIT), as the kind load test does. Every connect() the
// kernel saw is compared with what the client got (WATCHLOG_EBPF_LOAD=sustained).
func TestCountsMatchTheClientSustained(t *testing.T) {
	if os.Getenv("WATCHLOG_EBPF_LOAD") != "sustained" {
		t.Skip("set WATCHLOG_EBPF_LOAD=sustained")
	}
	f, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { buf := make([]byte, 1); _, _ = c.Read(buf); _ = c.Close() }()
		}
	}()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	var ok, failed atomic.Int64
	errs := map[string]int{}
	var mu sync.Mutex
	var total Flow
	deadline := time.Now().Add(70 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	var wg sync.WaitGroup
	next := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		<-tick.C
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := net.Dial("tcp4", ln.Addr().String())
			if err != nil {
				failed.Add(1)
				mu.Lock()
				errs[err.Error()]++
				mu.Unlock()
				return
			}
			_ = c.Close() // the client closes first: TIME_WAIT on this side
			ok.Add(1)
		}()
		if time.Now().After(next) {
			next = next.Add(15 * time.Second)
			flows, _ := f.Drain()
			for _, fl := range flows {
				if fl.Port == port {
					total.Connects += fl.Connects
					total.Failures += fl.Failures
					total.Established += fl.Established
				}
			}
		}
	}
	wg.Wait()
	flows, _ := f.Drain()
	for _, fl := range flows {
		if fl.Port == port {
			total.Connects += fl.Connects
			total.Failures += fl.Failures
			total.Established += fl.Established
		}
	}
	t.Logf("client ok=%d failed=%d errors=%v", ok.Load(), failed.Load(), errs)
	t.Logf("kernel connects=%d established=%d failures=%d", total.Connects, total.Established, total.Failures)
	if int64(total.Established) != ok.Load() || int64(total.Failures) != failed.Load() {
		t.Errorf("counters differ from the client")
	}
}
