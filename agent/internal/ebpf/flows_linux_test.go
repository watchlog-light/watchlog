// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package ebpf

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Runs only where eBPF may load (WATCHLOG_EBPF_TEST=1): in a container with just the
// BPF and PERFMON capabilities, as a non-root user, on a read-only root filesystem.
// It connects to a listener and to a closed port, then checks the drained counters
// and that they are attributed to this container's cgroup.
func TestFlowsInAContainer(t *testing.T) {
	if os.Getenv("WATCHLOG_EBPF_TEST") != "1" {
		t.Skip("set WATCHLOG_EBPF_TEST=1 to load eBPF programs")
	}
	if s := CheckSupport(KernelRelease(), "/sys"); !s.OK {
		t.Fatalf("unsupported: %s", s.Reason)
	}
	f, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	t.Logf("bytes hooks: %v %s", f.Bytes, f.BytesReason)

	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				buf := make([]byte, 100)
				_, _ = io.ReadFull(c, buf)
				_, _ = c.Write(buf[:50])
				_ = c.Close()
			}()
		}
	}()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	for range 5 {
		c, err := net.Dial("tcp4", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_, _ = c.Write(make([]byte, 100))
		_, _ = io.ReadFull(c, make([]byte, 50))
		_ = c.Close()
	}
	// A closed port: the SYN is answered with a reset.
	closed, _ := net.Listen("tcp4", "127.0.0.1:0")
	closedPort := uint16(closed.Addr().(*net.TCPAddr).Port)
	_ = closed.Close()
	if _, err := net.DialTimeout("tcp4", closed.Addr().String(), time.Second); err == nil {
		t.Fatal("connected to a closed port")
	}

	var st syscall.Stat_t
	if err := syscall.Stat("/sys/fs/cgroup", &st); err != nil {
		t.Fatal(err)
	}
	flows, err := f.Drain()
	if err != nil {
		t.Fatal(err)
	}
	var ok, failed *Flow
	for i := range flows {
		t.Logf("flow %+v", flows[i])
		switch flows[i].Port {
		case port:
			ok = &flows[i]
		case closedPort:
			failed = &flows[i]
		}
	}
	if ok == nil || ok.Connects != 5 || ok.Established != 5 || ok.Failures != 0 {
		t.Fatalf("listener flow = %+v", ok)
	}
	if ok.Cgroup != st.Ino {
		t.Errorf("cgroup %d, want this container's %d", ok.Cgroup, st.Ino)
	}
	if ok.Addr.String() != "127.0.0.1" || ok.LatSumNs == 0 {
		t.Errorf("addr %s, latency sum %d", ok.Addr, ok.LatSumNs)
	}
	if f.Bytes && (ok.BytesSent < 500 || ok.BytesRecv < 250) {
		t.Errorf("bytes sent %d, received %d", ok.BytesSent, ok.BytesRecv)
	}
	if failed == nil || failed.Connects != 1 || failed.Failures != 1 {
		t.Fatalf("closed-port flow = %+v", failed)
	}
	if f.DNS {
		// Real lookups through the container's resolver: one name that exists and one
		// that cannot (RFC 6761 .invalid).
		// Responses with answers reach user space for external names (ADR-104).
		var (
			mu      sync.Mutex
			answers [][]byte
		)
		go func() {
			_ = f.ReadDNSResponses(func(cgroup uint64, msg []byte) {
				if cgroup == st.Ino {
					mu.Lock()
					answers = append(answers, append([]byte(nil), msg...))
					mu.Unlock()
				}
			})
		}()
		r := &net.Resolver{PreferGo: true}
		lookup := func(name string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := r.LookupHost(ctx, name)
			return err
		}
		// A name that resolves; WATCHLOG_DNS_TEST_NAME where example.com does not.
		okName := cmp.Or(os.Getenv("WATCHLOG_DNS_TEST_NAME"), "example.com")
		okErr := lookup(okName)
		nxErr := lookup("watchlog-test.invalid")
		_ = lookup("www.github.com") // a CNAME chain
		t.Logf("lookups: %v / %v", okErr, nxErr)
		time.Sleep(100 * time.Millisecond)
		mu.Lock()
		got := answers
		mu.Unlock()
		if okErr == nil && !containsName(got, string(wireName(okName))) {
			t.Fatalf("no DNS answer for %s in %d messages", okName, len(got))
		}
		// NXDOMAIN responses reach user space up to their question (ADR-113).
		var dnsErr *net.DNSError
		if errors.As(nxErr, &dnsErr) && dnsErr.IsNotFound && !containsName(got, "\x0dwatchlog-test\x07invalid\x00") {
			t.Fatalf("no NXDOMAIN question for watchlog-test.invalid in %d messages", len(got))
		}
		for _, m := range got {
			if len(m) >= 12 && m[3]&0x0f == 3 && len(m) > 272 {
				t.Errorf("NXDOMAIN copied with %d bytes, want at most 272", len(m))
			}
		}
		if dir := os.Getenv("WATCHLOG_DNS_CAPTURE"); dir != "" {
			for i, m := range got {
				if err := os.WriteFile(fmt.Sprintf("%s/answer-%d.bin", dir, i), m, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			t.Logf("captured %d DNS answers to %s", len(got), dir)
		}
		_, _ = f.Drain()
		stats, err := f.DrainDNS()
		if err != nil {
			t.Fatal(err)
		}
		var mine *DNSStat
		for i := range stats {
			if stats[i].Cgroup == st.Ino {
				mine = &stats[i]
			}
		}
		if mine == nil || mine.Queries < 2 || mine.NXDomain < 1 || (okErr == nil && mine.NoError < 1) || mine.Timeouts != 0 {
			t.Fatalf("dns = %+v (all: %+v)", mine, stats)
		}
		t.Logf("dns %+v", *mine)
	} else {
		t.Logf("dns hooks not attached: %s", f.DNSReason)
	}

	// Drained: the next drain does not repeat them.
	again, _ := f.Drain()
	for _, fl := range again {
		if fl.Port == port {
			t.Errorf("counted twice: %+v", fl)
		}
	}
}

// wireName is a name as DNS writes it: each label after its length, then a zero.
func wireName(name string) []byte {
	var b []byte
	for _, l := range strings.Split(name, ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	return append(b, 0)
}

func containsName(msgs [][]byte, wire string) bool {
	for _, m := range msgs {
		if bytes.Contains(m, []byte(wire)) {
			return true
		}
	}
	return false
}

// A connection opened before the programs load (a pool, keep-alive) is adopted on its
// next bytes: the client side only, never the accepted server side.
func TestAdoptsConnectionsOpenBeforeLoad(t *testing.T) {
	if os.Getenv("WATCHLOG_EBPF_TEST") != "1" {
		t.Skip("set WATCHLOG_EBPF_TEST=1 to load eBPF programs")
	}
	// A listening port below the ephemeral range, like a real service.
	var ln net.Listener
	var err error
	for p := 20000; p < 20100; p++ {
		if ln, err = net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			break
		}
	}
	if ln == nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	client, err := net.Dial("tcp4", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Close() }()
	server := <-accepted
	defer func() { _ = server.Close() }()
	clientPort := uint16(client.LocalAddr().(*net.TCPAddr).Port)

	f, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if !f.Bytes {
		t.Skipf("bytes hooks not attached: %s", f.BytesReason)
	}
	_, _ = f.Drain()
	if _, err := client.Write(make([]byte, 300)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 300)
	if _, err := io.ReadFull(server, buf); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Write(make([]byte, 200)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(client, buf[:200]); err != nil {
		t.Fatal(err)
	}
	flows, err := f.Drain()
	if err != nil {
		t.Fatal(err)
	}
	var adopted *Flow
	for i := range flows {
		switch flows[i].Port {
		case port:
			adopted = &flows[i]
		case clientPort:
			t.Fatalf("server side adopted as a client: %+v", flows[i])
		}
	}
	if adopted == nil || adopted.BytesSent != 300 || adopted.BytesRecv != 200 || adopted.Connects != 0 {
		t.Fatalf("adopted flow = %+v", adopted)
	}
}
