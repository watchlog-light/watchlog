// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

// Package netsim simulates network devices for tests, the poller's budget run and the live
// demo (ADR-233): SNMP agents built from the public MIB definitions (a Catalyst, a stacked
// Catalyst, a Nexus, a generic device), whose counters move with time, and a RouterOS REST
// service. Values come from a model, never from a recorded walk of a real network.
package netsim

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Value is one OID's value. A counter's value is Base plus Rate per second since the agent
// started, wrapped at its width.
type Value struct {
	Type gosnmp.Asn1BER
	V    any
	Rate float64
	Base float64
}

// Agent is one simulated SNMP device: its values, in OID order, and per-VLAN tables
// (Cisco's community@vlan and vlan-<id> contexts).
type Agent struct {
	Name string
	// Users are the SNMPv3 users this device answers (1.0.4); none: the server's.
	Users []V3User
	mu    sync.RWMutex
	vals  map[string]*Value
	oids  []oidKey
	// vlans are the per-VLAN contexts' own values (BRIDGE-MIB).
	vlans map[int]*Agent
	start time.Time
	// rebootAt makes sysUpTime and every counter start over.
	ports map[string]int // port name → ifIndex
}

type oidKey struct {
	s     string
	parts []int
}

func parse(oid string) []int {
	f := strings.Split(strings.TrimPrefix(oid, "."), ".")
	out := make([]int, len(f))
	for i, p := range f {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}

func less(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// NewAgent makes an empty agent that started at start.
func NewAgent(name string, start time.Time) *Agent {
	return &Agent{Name: name, vals: map[string]*Value{}, vlans: map[int]*Agent{}, start: start, ports: map[string]int{}}
}

// Set stores a value (building the model; the simulator answers no SNMP SET).
func (a *Agent) Set(oid string, v Value) {
	a.mu.Lock()
	defer a.mu.Unlock()
	oid = strings.TrimPrefix(oid, ".")
	if _, ok := a.vals[oid]; !ok {
		a.oids = append(a.oids, oidKey{s: oid, parts: parse(oid)})
		a.oids = nil // re-sorted lazily
	}
	cp := v
	a.vals[oid] = &cp
}

// Str, Int, Gauge, Counter32, Counter64, OID, Ticks, Bytes and IP are shorthands.
func (a *Agent) Str(oid, s string)          { a.Set(oid, Value{Type: gosnmp.OctetString, V: []byte(s)}) }
func (a *Agent) Bytes(oid string, b []byte) { a.Set(oid, Value{Type: gosnmp.OctetString, V: b}) }
func (a *Agent) Int(oid string, n int)      { a.Set(oid, Value{Type: gosnmp.Integer, V: n}) }
func (a *Agent) Gauge(oid string, n uint)   { a.Set(oid, Value{Type: gosnmp.Gauge32, V: n}) }
func (a *Agent) OID(oid, v string)          { a.Set(oid, Value{Type: gosnmp.ObjectIdentifier, V: v}) }
func (a *Agent) IP(oid, ip string)          { a.Set(oid, Value{Type: gosnmp.IPAddress, V: ip}) }
func (a *Agent) Counter32(oid string, base, rate float64) {
	a.Set(oid, Value{Type: gosnmp.Counter32, Base: base, Rate: rate})
}
func (a *Agent) Counter64(oid string, base, rate float64) {
	a.Set(oid, Value{Type: gosnmp.Counter64, Base: base, Rate: rate})
}

// VLAN returns the agent of a VLAN's context, made on first use.
func (a *Agent) VLAN(vlan int) *Agent {
	a.mu.Lock()
	defer a.mu.Unlock()
	if v, ok := a.vlans[vlan]; ok {
		return v
	}
	v := NewAgent(a.Name+"@"+strconv.Itoa(vlan), a.start)
	a.vlans[vlan] = v
	return v
}

// Context returns the agent answering a community@vlan or a vlan-<id> context; itself when
// neither names a VLAN it has.
func (a *Agent) Context(community, context string) *Agent {
	s := ""
	if _, v, ok := strings.Cut(community, "@"); ok {
		s = v
	} else if v, ok := strings.CutPrefix(context, "vlan-"); ok {
		s = v
	}
	if s == "" {
		return a
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return a
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if v, ok := a.vlans[n]; ok {
		return v
	}
	return NewAgent(a.Name, a.start) // a VLAN the switch doesn't have: an empty table
}

// Reboot restarts the device at t: uptime and counters start over.
func (a *Agent) Reboot(t time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.start = t
	for _, v := range a.vals {
		if v.Rate != 0 || v.Base != 0 {
			v.Base = 0
		}
	}
}

func (a *Agent) sorted() []oidKey {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.oids == nil || len(a.oids) != len(a.vals) {
		a.oids = make([]oidKey, 0, len(a.vals))
		for k := range a.vals {
			a.oids = append(a.oids, oidKey{s: k, parts: parse(k)})
		}
		sort.Slice(a.oids, func(i, j int) bool { return less(a.oids[i].parts, a.oids[j].parts) })
	}
	return a.oids
}

// pdu renders a value at time now.
func (a *Agent) pdu(oid string, now time.Time) gosnmp.SnmpPDU {
	a.mu.RLock()
	v, ok := a.vals[oid]
	start := a.start
	a.mu.RUnlock()
	if !ok {
		return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.NoSuchObject}
	}
	secs := now.Sub(start).Seconds()
	switch v.Type {
	case gosnmp.TimeTicks:
		if v.V != nil {
			return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.TimeTicks, Value: v.V}
		}
		return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.TimeTicks, Value: uint32(uint64(secs*100) % (1 << 32))}
	case gosnmp.Counter32:
		n := math.Mod(v.Base+v.Rate*secs, 1<<32)
		return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.Counter32, Value: uint(n)}
	case gosnmp.Counter64:
		return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.Counter64, Value: uint64(v.Base + v.Rate*secs)}
	}
	return gosnmp.SnmpPDU{Name: "." + oid, Type: v.Type, Value: v.V}
}

// Get answers a GET.
func (a *Agent) Get(oid string, now time.Time) gosnmp.SnmpPDU {
	oid = strings.TrimPrefix(oid, ".")
	p := a.pdu(oid, now)
	if p.Type == gosnmp.NoSuchObject {
		p.Type = gosnmp.NoSuchInstance
	}
	return p
}

// Next answers a GETNEXT: the first OID after oid.
func (a *Agent) Next(oid string, now time.Time) gosnmp.SnmpPDU {
	key := parse(oid)
	ks := a.sorted()
	i := sort.Search(len(ks), func(i int) bool { return less(key, ks[i].parts) })
	if i >= len(ks) {
		return gosnmp.SnmpPDU{Name: "." + strings.TrimPrefix(oid, "."), Type: gosnmp.EndOfMibView}
	}
	return a.pdu(ks[i].s, now)
}

// Bulk answers a GETBULK for one OID: up to n values after oid.
func (a *Agent) Bulk(oid string, n int, now time.Time) []gosnmp.SnmpPDU {
	out := make([]gosnmp.SnmpPDU, 0, n)
	key := parse(oid)
	ks := a.sorted()
	i := sort.Search(len(ks), func(i int) bool { return less(key, ks[i].parts) })
	for ; i < len(ks) && len(out) < n; i++ {
		out = append(out, a.pdu(ks[i].s, now))
	}
	if len(out) < n {
		last := oid
		if len(out) > 0 {
			last = out[len(out)-1].Name
		}
		out = append(out, gosnmp.SnmpPDU{Name: last, Type: gosnmp.EndOfMibView})
	}
	return out
}

// Walk lists every OID and value at now (a fixture walk, "-On" style).
func (a *Agent) Walk(now time.Time) []gosnmp.SnmpPDU {
	ks := a.sorted()
	out := make([]gosnmp.SnmpPDU, len(ks))
	for i, k := range ks {
		out[i] = a.pdu(k.s, now)
	}
	return out
}

// Port is a port's ifIndex by name (0 when there is none).
func (a *Agent) Port(name string) int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.ports[name]
}

// SetOper sets a port's link up or down.
func (a *Agent) SetOper(name string, up bool) {
	if i := a.Port(name); i > 0 {
		st := 2
		if up {
			st = 1
		}
		a.Int(ifTable+".8."+strconv.Itoa(i), st)
	}
}

// SetRate sets a port's traffic in bytes per second, both ways, from now on.
func (a *Agent) SetRate(name string, now time.Time, inBps, outBps float64) {
	i := a.Port(name)
	if i == 0 {
		return
	}
	for col, r := range map[string]float64{".6.": inBps, ".10.": outBps} {
		oid := ifXTable + col + strconv.Itoa(i)
		a.mu.Lock()
		if v, ok := a.vals[oid]; ok {
			secs := now.Sub(a.start).Seconds()
			v.Base = v.Base + v.Rate*secs - r*secs
			v.Rate = r
		}
		a.mu.Unlock()
	}
}
