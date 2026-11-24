// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// readInventory reads the slow-changing tables, every 5 minutes: ports, neighbours, the MAC
// table and ARP. It refreshes the device's port names for the rounds in between.
func readInventory(ctx context.Context, r Reader, dial DialFunc, dev Device, p *Profile, st *snmpState) *Inventory {
	inv := &Inventory{Interfaces: []Interface{}, Neighbours: []Neighbour{}, MACs: []MACEntry{}, ARP: []ARPEntry{}}
	i := p.Interfaces
	if i == nil {
		return inv
	}
	names, _ := walkCol(ctx, r, i.Name)
	descrs, _ := walkCol(ctx, r, i.Descr)
	aliases, _ := walkCol(ctx, r, i.Alias)
	types, _ := walkCol(ctx, r, i.Type)
	macs, _ := walkCol(ctx, r, i.PhysAddress)
	high, _ := walkCol(ctx, r, i.HighSpeed)
	oper, _ := walkCol(ctx, r, i.OperStatus)
	admin, _ := walkCol(ctx, r, i.AdminStatus)
	ifs := map[int]ifMeta{}
	byName := map[string]int{}
	for _, idx := range sortedIdx(types) {
		n, err := strconv.Atoi(idx)
		if err != nil {
			continue
		}
		name := names.str(idx)
		if name == "" {
			name = descrs.str(idx)
		}
		speed, _ := high.num(idx)
		t, _ := types.num(idx)
		m := ifMeta{Name: name, Descr: descrs.str(idx), Alias: aliases.str(idx), Kind: ifKind(t, name, int64(speed))}
		ifs[n] = m
		byName[strings.ToLower(name)] = n
		byName[strings.ToLower(m.Descr)] = n
		o, _ := oper.num(idx)
		a, _ := admin.num(idx)
		inv.Interfaces = append(inv.Interfaces, Interface{
			Index: n, Name: name, Descr: m.Descr, Alias: m.Alias, Kind: m.Kind, MAC: macOf(macs[idx]),
			SpeedMbps: int64(speed), OperUp: o == 1, AdminUp: a == 1,
		})
	}
	st.ifs = ifs
	nameOf := func(ifIndex int) string { return ifs[ifIndex].Name }

	// Bridge ports → ifIndex (both MAC tables and the port VLAN ids are by bridge port).
	var bridge table
	if p.MACs != nil {
		bridge, _ = walkCol(ctx, r, p.MACs.BasePortIfIndex)
	}
	bridgeIf := func(t table, bp string) int {
		f, ok := t.num(bp)
		if !ok {
			return 0
		}
		return int(f)
	}
	if i.PVID != "" {
		pvid, _ := walkCol(ctx, r, i.PVID)
		for bp, v := range pvid {
			f, _ := num(v)
			if ifi := bridgeIf(bridge, bp); ifi > 0 {
				setVLAN(inv, ifi, int(f))
			}
		}
	}
	if p.PoE != nil && p.PoE.Detection != "" {
		readPoE(ctx, r, p, inv, byName)
	}
	inv.Neighbours = readNeighbours(ctx, r, p, nameOf, byName)
	inv.MACs = readMACs(ctx, r, dial, dev, p, bridge, nameOf)
	inv.ARP = readARP(ctx, r, p)

	busy := map[string]bool{}
	for _, n := range inv.Neighbours {
		busy[n.LocalPort] = true
	}
	for _, m := range inv.MACs {
		busy[m.Port] = true
	}
	st.busy = busy
	return inv
}

func setVLAN(inv *Inventory, ifIndex, vlan int) {
	for k := range inv.Interfaces {
		if inv.Interfaces[k].Index == ifIndex && vlan > 0 {
			for _, v := range inv.Interfaces[k].VLANs {
				if v == vlan {
					return
				}
			}
			inv.Interfaces[k].VLANs = append(inv.Interfaces[k].VLANs, vlan)
			sort.Ints(inv.Interfaces[k].VLANs)
		}
	}
}

// readPoE reads each PSE port's draw (milliwatts → watts) and puts it on the port.
func readPoE(ctx context.Context, r Reader, p *Profile, inv *Inventory, byName map[string]int) {
	det, err := walkCol(ctx, r, p.PoE.Detection)
	if err != nil || len(det) == 0 {
		return
	}
	cons, _ := walkCol(ctx, r, p.PoE.Consumption)
	ent, _ := walkCol(ctx, r, p.PoE.PortName)
	var entNames table
	if len(ent) > 0 && p.Entity != nil {
		entNames, _ = walkCol(ctx, r, p.Entity.Name)
	}
	for _, idx := range sortedIdx(det) {
		// idx is group.port; without a name table, group 1 port n is the n-th port.
		var ifi int
		if e, ok := ent.num(idx); ok {
			ifi = byName[strings.ToLower(entNames.str(strconv.Itoa(int(e))))]
		}
		if ifi == 0 {
			_, port, _ := strings.Cut(idx, ".")
			n, _ := strconv.Atoi(port)
			ifi = nthPort(inv, n)
		}
		if ifi == 0 {
			continue
		}
		state, _ := det.num(idx)
		w := 0.0
		if mw, ok := cons.num(idx); ok {
			w = mw / 1000
		}
		if state != 3 && w == 0 { // deliveringPower 3
			continue
		}
		for k := range inv.Interfaces {
			if inv.Interfaces[k].Index == ifi {
				ww := w
				inv.Interfaces[k].PoEWatts = &ww
			}
		}
	}
}

func nthPort(inv *Inventory, n int) int {
	k := 0
	for _, i := range inv.Interfaces {
		if i.Kind == "ethernet" {
			k++
			if k == n {
				return i.Index
			}
		}
	}
	return 0
}

// readNeighbours reads CDP (by ifIndex) and LLDP (by the local port number).
func readNeighbours(ctx context.Context, r Reader, p *Profile, nameOf func(int) string, byName map[string]int) []Neighbour {
	out := []Neighbour{}
	for _, n := range p.Neighbours {
		switch n.Protocol {
		case "cdp":
			ids, err := walkCol(ctx, r, n.DeviceID)
			if err != nil {
				continue
			}
			ports, _ := walkCol(ctx, r, n.Port)
			addrs, _ := walkCol(ctx, r, n.Address)
			plats, _ := walkCol(ctx, r, n.Platform)
			for _, idx := range sortedIdx(ids) {
				ifIdx, _, _ := strings.Cut(idx, ".")
				ifi, _ := strconv.Atoi(ifIdx)
				local := nameOf(ifi)
				if local == "" {
					continue
				}
				out = append(out, Neighbour{
					LocalPort: local, Protocol: "cdp", RemoteName: cdpName(ids.str(idx)),
					RemotePort: ports.str(idx), RemoteAddr: ipv4Of(addrs[idx]), Platform: plats.str(idx),
				})
			}
		case "lldp":
			sys, err := walkCol(ctx, r, n.SysName)
			if err != nil {
				continue
			}
			chassis, _ := walkCol(ctx, r, n.ChassisID)
			ports, _ := walkCol(ctx, r, n.Port)
			pdescr, _ := walkCol(ctx, r, n.PortDescr)
			plats, _ := walkCol(ctx, r, n.Platform)
			locID, _ := walkCol(ctx, r, n.LocalPort)
			locDescr, _ := walkCol(ctx, r, n.LocalDescr)
			man, _ := walkCol(ctx, r, n.ManAddr)
			addrOf := map[string]string{} // localPort.remIndex → IPv4
			for k := range man {
				// timeMark.localPort.remIndex.subtype.len.a.b.c.d
				parts := strings.Split(k, ".")
				if len(parts) == 9 && parts[3] == "1" && parts[4] == "4" {
					addrOf[parts[1]+"."+parts[2]] = ipv4FromIndex(parts[5:9])
				}
			}
			idxs := sortedIdx(chassis)
			if len(idxs) == 0 {
				idxs = sortedIdx(sys)
			}
			for _, idx := range idxs {
				parts := strings.Split(idx, ".")
				if len(parts) != 3 {
					continue
				}
				lp := parts[1]
				local := localPortName(locID.str(lp), locDescr.str(lp), byName, nameOf)
				if local == "" {
					continue
				}
				rp := ports.str(idx)
				if strings.Count(rp, ":") == 5 && pdescr.str(idx) != "" {
					rp = pdescr.str(idx) // a MAC as the port id: the description reads better
				}
				nb := Neighbour{
					LocalPort: local, Protocol: "lldp", RemoteName: sys.str(idx), RemotePort: rp,
					RemoteAddr: addrOf[lp+"."+parts[2]], Platform: firstLine(plats.str(idx)),
				}
				if c, ok := chassis[idx]; ok {
					nb.RemoteMAC = macOf(c)
				}
				out = append(out, nb)
			}
		}
	}
	return out
}

// cdpName drops a serial number in parentheses and a domain: "core-1.example.lan(FOX123)"
// → "core-1".
func cdpName(s string) string {
	if i := strings.IndexByte(s, '('); i > 0 {
		s = s[:i]
	}
	return s
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return strings.TrimSpace(s)
}

// localPortName maps LLDP's local port (its id, else its description) to the port's name.
func localPortName(id, descr string, byName map[string]int, nameOf func(int) string) string {
	for _, s := range []string{id, descr} {
		if s == "" {
			continue
		}
		if n, ok := byName[strings.ToLower(s)]; ok {
			return nameOf(n)
		}
	}
	// Some devices give the ifIndex as the local port id.
	if n, err := strconv.Atoi(id); err == nil && nameOf(n) != "" {
		return nameOf(n)
	}
	return ""
}

// readMACs reads the forwarding table: Q-BRIDGE-MIB when there is one, else BRIDGE-MIB, per
// VLAN on Cisco IOS.
func readMACs(ctx context.Context, r Reader, dial DialFunc, dev Device, p *Profile, bridge table, nameOf func(int) string) []MACEntry {
	out := []MACEntry{}
	m := p.MACs
	if m == nil {
		return out
	}
	if m.QFdbPort != "" {
		ports, err := walkCol(ctx, r, m.QFdbPort)
		if err == nil && len(ports) > 0 {
			status, _ := walkCol(ctx, r, m.QFdbStatus)
			for _, idx := range sortedIdx(ports) {
				parts := strings.Split(idx, ".")
				if len(parts) != 7 || !learned(status, idx) {
					continue
				}
				vlan, _ := strconv.Atoi(parts[0])
				bp, _ := ports.num(idx)
				ifi, _ := bridge.num(strconv.Itoa(int(bp)))
				if port := nameOf(int(ifi)); port != "" {
					out = append(out, MACEntry{Port: port, MAC: macFromIndex(parts[1:]), VLAN: vlan})
				}
			}
			return out
		}
	}
	read := func(rr Reader, vlan int, br table) {
		ports, err := walkCol(ctx, rr, m.FdbPort)
		if err != nil {
			return
		}
		status, _ := walkCol(ctx, rr, m.FdbStatus)
		for _, idx := range sortedIdx(ports) {
			parts := strings.Split(idx, ".")
			if len(parts) != 6 || !learned(status, idx) {
				continue
			}
			bp, _ := ports.num(idx)
			ifi, _ := br.num(strconv.Itoa(int(bp)))
			if port := nameOf(int(ifi)); port != "" {
				out = append(out, MACEntry{Port: port, MAC: macFromIndex(parts), VLAN: vlan})
			}
		}
	}
	if m.PerVLAN != "cisco" || m.VLANList == "" || dev.SNMP == nil {
		read(r, 0, bridge)
		return out
	}
	vlans, _ := walkCol(ctx, r, m.VLANList)
	n := 0
	for _, idx := range sortedIdx(vlans) {
		st, _ := vlans.num(idx)
		_, vs, _ := strings.Cut(idx, ".") // management domain . vlan
		vlan, err := strconv.Atoi(vs)
		if err != nil || st != 1 || (vlan >= 1002 && vlan <= 1005) {
			continue
		}
		if n++; n > MaxVLANs {
			break
		}
		community, v3ctx := "", ""
		if dev.SNMP.Version == "2c" {
			community = fmt.Sprintf("%s@%d", dev.SNMP.Community, vlan)
		} else {
			v3ctx = fmt.Sprintf("vlan-%d", vlan)
		}
		vr, err := dial(dev.Address, dev.SNMP, v3ctx, community)
		if err != nil {
			continue
		}
		br, _ := walkCol(ctx, vr, m.BasePortIfIndex)
		read(vr, vlan, br)
		_ = vr.Close()
	}
	return out
}

// learned keeps entries whose status is learned (3), or that have no status.
func learned(status table, idx string) bool {
	f, ok := status.num(idx)
	return !ok || f == 3
}

// readARP reads IP-MIB's ARP tables, IPv4 only.
func readARP(ctx context.Context, r Reader, p *Profile) []ARPEntry {
	out := []ARPEntry{}
	if p.ARP == nil {
		return out
	}
	seen := map[string]bool{}
	add := func(mac, ip string) {
		if mac == "" || ip == "" || seen[mac+ip] {
			return
		}
		seen[mac+ip] = true
		out = append(out, ARPEntry{MAC: mac, IP: ip})
	}
	phys, _ := walkCol(ctx, r, p.ARP.NetToPhysPhys)
	for _, idx := range sortedIdx(phys) {
		parts := strings.Split(idx, ".") // ifIndex.type.len.a.b.c.d
		if len(parts) == 7 && parts[1] == "1" && parts[2] == "4" {
			add(macOf(phys[idx]), ipv4FromIndex(parts[3:]))
		}
	}
	if len(out) == 0 {
		media, _ := walkCol(ctx, r, p.ARP.NetToMediaPhys)
		for _, idx := range sortedIdx(media) {
			parts := strings.Split(idx, ".") // ifIndex.a.b.c.d
			if len(parts) == 5 {
				add(macOf(media[idx]), ipv4FromIndex(parts[1:]))
			}
		}
	}
	return out
}
