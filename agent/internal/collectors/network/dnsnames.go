// SPDX-License-Identifier: AGPL-3.0-only

package network

import (
	"encoding/binary"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
)

// External destinations are named by what the container looked up (ADR-104): the
// question and the A, AAAA and CNAME answers of its DNS responses, kept only in this
// map, never stored and never sent except as an edge's destination name.
const (
	// MaxNames bounds the map; the entry closest to expiry makes room.
	MaxNames = 10000
	// minNameTTL: resolvers answer with TTL 0 or 5 s (measured: Lima's DNS proxy,
	// CoreDNS on kind), shorter than the 15 s between drains.
	minNameTTL = time.Minute
	// nameHold keeps a name while connections to its address continue, so a
	// long-lived connection's edge keeps its name after the TTL.
	nameHold = 10 * time.Minute
)

type nameKey struct {
	cgroup uint64
	addr   netip.Addr
}

type nameEntry struct {
	name    string
	expires time.Time
}

// Names maps (cgroup, address) to the DNS name that container resolved it from.
type Names struct {
	mu  sync.Mutex
	m   map[nameKey]nameEntry
	now func() time.Time
}

// NewNames returns an empty map.
func NewNames() *Names {
	return &Names{m: map[nameKey]nameEntry{}, now: time.Now}
}

// Add records the addresses in one DNS response (from ebpf.Flows.ReadDNSResponses).
func (n *Names) Add(cgroup uint64, msg []byte) {
	if rcode(msg) != rcodeNoError {
		return
	}
	name, answers := parseAnswers(msg)
	if name == "" || len(answers) == 0 {
		return
	}
	now := n.now()
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range answers {
		ttl := time.Duration(a.ttl) * time.Second
		if ttl < minNameTTL {
			ttl = minNameTTL
		}
		k := nameKey{cgroup, a.addr}
		if _, ok := n.m[k]; !ok && len(n.m) >= MaxNames {
			n.evict(now)
		}
		n.m[k] = nameEntry{name: name, expires: now.Add(ttl)}
	}
}

// Lookup gives the name a container resolved an address from, and holds it for as
// long as connections to the address continue.
func (n *Names) Lookup(cgroup uint64, a netip.Addr) (string, bool) {
	now := n.now()
	k := nameKey{cgroup, a.Unmap()}
	n.mu.Lock()
	defer n.mu.Unlock()
	e, ok := n.m[k]
	if !ok {
		return "", false
	}
	if now.After(e.expires) {
		delete(n.m, k)
		return "", false
	}
	if hold := now.Add(nameHold); hold.After(e.expires) {
		e.expires = hold
		n.m[k] = e
	}
	return e.name, true
}

// Len is the number of names held (a self-metric).
func (n *Names) Len() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.m)
}

// evict drops expired entries and, if that is not enough, the tenth of the map
// closest to expiry, so a full map is swept once per MaxNames/10 new names.
func (n *Names) evict(now time.Time) {
	exp := make([]time.Time, 0, len(n.m))
	for k, e := range n.m {
		if now.After(e.expires) {
			delete(n.m, k)
			continue
		}
		exp = append(exp, e.expires)
	}
	if len(n.m) < MaxNames*9/10 {
		return
	}
	slices.SortFunc(exp, time.Time.Compare)
	cut := exp[len(exp)-MaxNames*9/10]
	for k, e := range n.m {
		if e.expires.Before(cut) {
			delete(n.m, k)
		}
	}
}

type answer struct {
	addr netip.Addr
	ttl  uint32
}

const (
	typeA    = 1
	typeAAAA = 28
	classIN  = 1

	rcodeNoError  = 0
	rcodeNXDomain = 3
)

// rcode is the response code in a DNS header, or -1 for a message shorter than one.
func rcode(msg []byte) int {
	if len(msg) < 12 {
		return -1
	}
	return int(msg[3] & 0x0f)
}

// parseAnswers reads the question name and the A and AAAA answers of a DNS response.
// CNAME answers are skipped: the addresses at the end of the chain belong to the name
// the container asked for. Other records are not read. A malformed or truncated
// message gives what was read before the problem.
func parseAnswers(msg []byte) (string, []answer) {
	if len(msg) < 12 || binary.BigEndian.Uint16(msg[4:6]) != 1 {
		return "", nil
	}
	ancount := int(binary.BigEndian.Uint16(msg[6:8]))
	name, off, ok := readName(msg, 12)
	if !ok || off+4 > len(msg) {
		return "", nil
	}
	off += 4 // QTYPE, QCLASS
	var out []answer
	for i := 0; i < ancount; i++ {
		_, next, ok := readName(msg, off)
		if !ok || next+10 > len(msg) {
			break
		}
		typ := binary.BigEndian.Uint16(msg[next : next+2])
		class := binary.BigEndian.Uint16(msg[next+2 : next+4])
		ttl := binary.BigEndian.Uint32(msg[next+4 : next+8])
		rdlen := int(binary.BigEndian.Uint16(msg[next+8 : next+10]))
		rdata := next + 10
		if rdata+rdlen > len(msg) {
			break
		}
		if class == classIN {
			switch {
			case typ == typeA && rdlen == 4:
				out = append(out, answer{netip.AddrFrom4([4]byte(msg[rdata : rdata+4])), ttl})
			case typ == typeAAAA && rdlen == 16:
				out = append(out, answer{netip.AddrFrom16([16]byte(msg[rdata : rdata+16])).Unmap(), ttl})
			}
		}
		off = rdata + rdlen
	}
	return name, out
}

// readName decodes a domain name at off, following compression pointers, and returns
// it in lower case without the trailing dot, with the offset after it in the message.
// Names with characters outside letters, digits, '-' and '_' are rejected.
func readName(msg []byte, off int) (string, int, bool) {
	var (
		b     strings.Builder
		end   = -1
		jumps = 0
	)
	for {
		if off >= len(msg) {
			return "", 0, false
		}
		l := int(msg[off])
		switch {
		case l == 0:
			if end < 0 {
				end = off + 1
			}
			name := b.String()
			return name, end, len(name) <= 253
		case l&0xc0 == 0xc0:
			if off+1 >= len(msg) || jumps > 10 {
				return "", 0, false
			}
			if end < 0 {
				end = off + 2
			}
			off = int(binary.BigEndian.Uint16(msg[off:off+2]) & 0x3fff)
			jumps++
		case l > 63 || off+1+l > len(msg):
			return "", 0, false
		default:
			if b.Len() > 0 {
				b.WriteByte('.')
			}
			for _, c := range msg[off+1 : off+1+l] {
				switch {
				case c >= 'A' && c <= 'Z':
					c += 'a' - 'A'
				case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
				default:
					return "", 0, false
				}
				b.WriteByte(c)
			}
			off += 1 + l
		}
	}
}
