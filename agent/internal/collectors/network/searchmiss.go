// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"bufio"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Search-path misses (ADR-113): a resolver with ndots:5 tries a name such as example.com
// under each search domain (example.com.<ns>.svc.cluster.local, …) before the name
// itself, and those tries end in NXDOMAIN. They are the resolver at work, not failed
// lookups, so an NXDOMAIN whose question is under a search domain is counted on its own
// and left out of the DNS errors. The name the client asked for, tried last, still
// counts when it does not exist.

// SearchDomains reads the search list of a resolv.conf: the agent's own, which in a
// pod is the list kubelet gives every pod on the node (<ns>.svc.<cluster domain>,
// svc.<cluster domain>, <cluster domain>, then the node's), and in Docker the host's.
// The last search or domain line wins, as in the resolver. Nil when the file is missing.
func SearchDomains(path string) []string {
	f, err := os.Open(filepath.Clean(path))
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 || (fields[0] != "search" && fields[0] != "domain") {
			continue
		}
		out = out[:0]
		for _, d := range fields[1:] {
			d = strings.Trim(strings.ToLower(d), ".")
			if d != "" {
				out = append(out, d)
			}
		}
	}
	return out
}

// SearchMisses counts NXDOMAIN responses for names under the search domains, per
// cgroup, until the collector takes them at the next drain.
type SearchMisses struct {
	// suffixes are ".<domain>": a miss is a name that ends in one, not the domain itself.
	suffixes []string
	mu       sync.Mutex
	cur, old map[uint64]uint64
}

// NewSearchMisses returns a counter for these search domains; nil when there are none.
func NewSearchMisses(domains []string) *SearchMisses {
	if len(domains) == 0 {
		return nil
	}
	s := &SearchMisses{cur: map[uint64]uint64{}, old: map[uint64]uint64{}}
	for _, d := range domains {
		s.suffixes = append(s.suffixes, "."+d)
	}
	return s
}

// Add counts one DNS response (from ebpf.Flows.ReadDNSResponses) when it is an
// NXDOMAIN for a name under a search domain.
func (s *SearchMisses) Add(cgroup uint64, msg []byte) {
	if rcode(msg) != rcodeNXDomain || binary.BigEndian.Uint16(msg[4:6]) != 1 {
		return
	}
	name, _, ok := readName(msg, 12)
	if !ok || !s.under(name) {
		return
	}
	s.mu.Lock()
	s.cur[cgroup]++
	s.mu.Unlock()
}

func (s *SearchMisses) under(name string) bool {
	for _, suf := range s.suffixes {
		if strings.HasSuffix(name, suf) {
			return true
		}
	}
	return false
}

// take gives a cgroup's misses, at most nx (the NXDOMAIN responses the kernel counted
// in the same drain). Misses read just after a drain wait for the next one; misses
// still unclaimed after two drains are dropped by rotate.
func (s *SearchMisses) take(cgroup, nx uint64) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var got uint64
	for _, m := range []map[uint64]uint64{s.old, s.cur} {
		n := min(m[cgroup], nx-got)
		got += n
		if m[cgroup] -= n; m[cgroup] == 0 {
			delete(m, cgroup)
		}
	}
	return got
}

// rotate ends a drain: what is left of the previous drain is dropped.
func (s *SearchMisses) rotate() {
	s.mu.Lock()
	s.old, s.cur = s.cur, map[uint64]uint64{}
	s.mu.Unlock()
}
