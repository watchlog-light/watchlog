// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"
)

// Discovery limits (ADR-233).
const (
	// SweepRate bounds the sweep to 20 addresses a second.
	SweepRate = 20
	// MaxSweepBits: a range is a /24 or smaller.
	MaxSweepBits = 8
	// MaxNeighbourHops and MaxFound bound neighbour discovery.
	MaxNeighbourHops = 3
	MaxFound         = 512
	probeTimeout     = 3 * time.Second
)

// probeEvery is the pause between two sweep probes (tests shorten it).
var probeEvery = time.Second / SweepRate

// RangeAddrs lists a range's host addresses; a range wider than a /24 is refused.
func RangeAddrs(cidr string) ([]string, error) {
	pfx, err := netip.ParsePrefix(strings.TrimSpace(cidr))
	if err != nil {
		return nil, fmt.Errorf("%q isn't a range like 10.0.10.0/24", cidr)
	}
	if !pfx.Addr().Is4() {
		return nil, fmt.Errorf("only IPv4 ranges are swept")
	}
	if 32-pfx.Bits() > MaxSweepBits {
		return nil, fmt.Errorf("%s is wider than a /24", cidr)
	}
	pfx = pfx.Masked()
	var out []string
	for a := pfx.Addr(); pfx.Contains(a); a = a.Next() {
		out = append(out, a.String())
	}
	if len(out) > 2 {
		out = out[1 : len(out)-1] // network and broadcast
	}
	return out, nil
}

// discover runs one discovery: the seeds and the range, each with each credential, then the
// neighbours the answering devices report, up to 3 hops. Nothing is added: what answered is
// proposed on the Add page.
func (p *Poller) discover(ctx context.Context, d Discovery) {
	var mu sync.Mutex
	found := map[string]*Found{}
	var order []string
	publish := func(done bool) {
		mu.Lock()
		out := make([]Found, 0, len(order))
		for _, a := range order {
			out = append(out, *found[a])
		}
		mu.Unlock()
		p.addDiscovery(DiscoveryReport{ID: d.ID, Done: done, Found: out})
	}
	add := func(f Found) bool {
		mu.Lock()
		defer mu.Unlock()
		if old, ok := found[f.Address]; ok {
			if f.Answered && !old.Answered {
				f.ViaNeighbour = old.ViaNeighbour
				*old = f
			}
			return false
		}
		if len(order) >= MaxFound {
			return false
		}
		cp := f
		found[f.Address] = &cp
		order = append(order, f.Address)
		return true
	}

	var addrs []string
	addrs = append(addrs, d.Seeds...)
	if d.Range != "" {
		r, err := RangeAddrs(d.Range)
		if err != nil {
			add(Found{Address: d.Range, Error: err.Error()})
		}
		addrs = append(addrs, r...)
	}
	seen := map[string]bool{}
	next := []string{}
	for _, a := range addrs {
		a = strings.TrimSpace(a)
		if a != "" && !seen[a] {
			seen[a] = true
			next = append(next, a)
		}
	}
	seeds := map[string]bool{}
	for _, s := range d.Seeds {
		seeds[strings.TrimSpace(s)] = true
	}
	tick := time.NewTicker(max(probeEvery, time.Millisecond))
	defer tick.Stop()
	for hop := 0; hop <= MaxNeighbourHops && len(next) > 0; hop++ {
		var wg sync.WaitGroup
		var nmu sync.Mutex
		var proposed []Found
		for _, a := range next {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			wg.Add(1)
			go func(addr string) {
				defer wg.Done()
				f, neigh := p.probe(ctx, addr, d, d.Neighbours && (hop > 0 || seeds[addr]))
				if f.Answered || seeds[addr] || hop > 0 {
					add(f)
				}
				nmu.Lock()
				proposed = append(proposed, neigh...)
				nmu.Unlock()
			}(a)
		}
		wg.Wait()
		publish(false)
		next = next[:0]
		for _, n := range proposed {
			if n.Address == "" || seen[n.Address] {
				continue
			}
			seen[n.Address] = true
			if add(n) {
				next = append(next, n.Address)
			}
		}
	}
	mu.Lock()
	sort.SliceStable(order, func(i, j int) bool { return found[order[i]].Answered && !found[order[j]].Answered })
	mu.Unlock()
	publish(true)
}

// probe tries each credential on an address; with neighbours, it also reads the device's
// CDP, LLDP or MNDP table and proposes what it sees.
func (p *Poller) probe(ctx context.Context, addr string, d Discovery, neighbours bool) (Found, []Found) {
	f := Found{Address: addr, Error: errNoCredential.Error()}
	for _, c := range d.Credentials {
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		switch c.Protocol {
		case "routeros":
			r, err := p.dialROS(pctx, addr, c.RouterOS)
			if err != nil {
				cancel()
				f.Error = err.Error()
				continue
			}
			id, _ := r.Print(pctx, "system/identity")
			res, _ := r.Print(pctx, "system/resource")
			f = Found{Address: addr, Vendor: "MikroTik", Profile: "mikrotik", Credential: c.ID, Protocol: "routeros", Answered: true}
			if len(id) > 0 {
				f.Name = id[0]["name"]
			}
			if len(res) > 0 {
				f.Model = res[0]["board-name"]
			}
			var out []Found
			if neighbours {
				rows, _ := r.Print(pctx, "ip/neighbor")
				for _, n := range rows {
					if n["address"] != "" {
						out = append(out, Found{Address: n["address"], Name: n["identity"], Model: strings.TrimSpace(n["board"]), ViaNeighbour: f.Name})
					}
				}
			}
			_ = r.Close()
			cancel()
			return f, out
		default:
			r, err := p.dial(addr, c.SNMP, "", "")
			if err != nil {
				cancel()
				f.Error = err.Error()
				continue
			}
			sys, err := readSystem(pctx, r)
			if err != nil {
				_ = r.Close()
				cancel()
				f.Error = err.Error()
				continue
			}
			prof := p.profiles.For(sys.ObjectID, sys.Descr)
			readEntity(pctx, r, prof, sys)
			f = Found{Address: addr, Name: sys.Name, Model: sys.Model, Vendor: prof.Vendor, Profile: prof.Name, Credential: c.ID, Protocol: "snmp", Answered: true}
			if f.Model == "" {
				f.Model = firstLine(sys.Descr)
			}
			var out []Found
			if neighbours {
				st := newSNMPState()
				dev := Device{Address: addr, SNMP: c.SNMP}
				inv := readInventory(pctx, r, p.dial, dev, &Profile{Interfaces: prof.Interfaces, Neighbours: prof.Neighbours}, st)
				for _, n := range inv.Neighbours {
					if n.RemoteAddr != "" {
						out = append(out, Found{Address: n.RemoteAddr, Name: n.RemoteName, Model: n.Platform, ViaNeighbour: f.Name})
					}
				}
			}
			_ = r.Close()
			cancel()
			return f, out
		}
	}
	return f, nil
}
