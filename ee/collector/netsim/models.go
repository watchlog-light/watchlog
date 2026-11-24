// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"fmt"
	"hash/fnv"
	"net"
	"strconv"
	"time"

	"github.com/gosnmp/gosnmp"
)

// The MIB tables the models fill (public MIB definitions).
const (
	sysPrefix   = "1.3.6.1.2.1.1"
	ifTable     = "1.3.6.1.2.1.2.2.1"
	ifXTable    = "1.3.6.1.2.1.31.1.1.1"
	dot3FCS     = "1.3.6.1.2.1.10.7.2.1.3"
	entPhys     = "1.3.6.1.2.1.47.1.1.1.1"
	lldpRem     = "1.0.8802.1.1.2.1.4.1.1"
	lldpLocPort = "1.0.8802.1.1.2.1.3.7.1"
	lldpManAddr = "1.0.8802.1.1.2.1.4.2.1"
	basePortIf  = "1.3.6.1.2.1.17.1.4.1.2"
	tpFdb       = "1.3.6.1.2.1.17.4.3.1"
	qTpFdb      = "1.3.6.1.2.1.17.7.1.2.2.1"
	qPvid       = "1.3.6.1.2.1.17.7.1.4.5.1.1"
	arpMedia    = "1.3.6.1.2.1.4.22.1.2"
	hrProc      = "1.3.6.1.2.1.25.3.3.1.2"
	hrStorage   = "1.3.6.1.2.1.25.2.3.1"
	pethPort    = "1.3.6.1.2.1.105.1.1.1"
	ciscoCPU    = "1.3.6.1.4.1.9.9.109.1.1.1.1.7"
	cempPool    = "1.3.6.1.4.1.9.9.221.1.1.1.1"
	envTemp     = "1.3.6.1.4.1.9.9.13.1.3.1"
	envFan      = "1.3.6.1.4.1.9.9.13.1.4.1"
	envPSU      = "1.3.6.1.4.1.9.9.13.1.5.1"
	entSensor   = "1.3.6.1.4.1.9.9.91.1.1.1.1"
	entSensThr  = "1.3.6.1.4.1.9.9.91.1.2.1.1"
	cdpCache    = "1.3.6.1.4.1.9.9.23.1.2.1.1"
	cpeExtPort  = "1.3.6.1.4.1.9.9.402.1.2.1"
	cswInfo     = "1.3.6.1.4.1.9.9.500.1.2.1.1"
	vtpVlan     = "1.3.6.1.4.1.9.9.46.1.3.1.1.2"
	cseMem      = "1.3.6.1.4.1.9.9.305.1.1.2.0"
	cefcFan     = "1.3.6.1.4.1.9.9.117.1.4.1.1.1"
	cefcPower   = "1.3.6.1.4.1.9.9.117.1.1.2.1.2"
)

// The sysObjectIDs the models answer with (CISCO-PRODUCTS-MIB, MIKROTIK-MIB).
const (
	OIDCatalyst2960X = "1.3.6.1.4.1.9.1.1208"
	OIDCatalyst2960S = "1.3.6.1.4.1.9.1.1257"
	OIDCatalyst3850  = "1.3.6.1.4.1.9.1.2134"
	OIDNexus3064     = "1.3.6.1.4.1.9.12.3.1.3.1106"
	OIDMikroTik      = "1.3.6.1.4.1.14988.1"
	OIDNetSNMPLinux  = "1.3.6.1.4.1.8072.3.2.10"
)

// Neighbour is a device the model's port sees over CDP and LLDP.
type Neighbour struct {
	Port, RemoteName, RemotePort, RemoteAddr, Platform string
	RemoteMAC                                          string
}

// Endpoint is a MAC address learnt behind a port.
type Endpoint struct {
	Port string
	MAC  string
	VLAN int
	IP   string
}

// Spec describes one simulated device.
type Spec struct {
	Name       string
	Model      string  // a Catalyst2960X, Catalyst2960S, Catalyst3850, Nexus3064 or Generic
	Ports      int     // copper ports (Catalyst) or SFP+ ports (Nexus)
	Uplinks    int     // SFP uplinks (Catalyst) or QSFP (Nexus)
	Members    int     // stack members (Catalyst3850)
	Up         float64 // the share of copper ports with a link, 0..1
	Address    string
	Neighbours []Neighbour
	Endpoints  []Endpoint
	VLANs      []int
	Seed       int
}

func seeded(name string, n int) uint32 {
	h := fnv.New32a()
	_, _ = fmt.Fprintf(h, "%s/%d", name, n)
	return h.Sum32()
}

// Build makes the device's agent at start.
func Build(s Spec, start time.Time) *Agent {
	a := NewAgent(s.Name, start)
	if s.Up == 0 {
		s.Up = 0.7
	}
	if len(s.VLANs) == 0 {
		s.VLANs = []int{1, 10, 20}
	}
	switch s.Model {
	case "Catalyst3850":
		if s.Members == 0 {
			s.Members = 1
		}
		catalyst(a, s, OIDCatalyst3850, "WS-C3850-48P", "Cisco IOS Software [Amsterdam], Catalyst L3 Switch Software (CAT3K_CAA-UNIVERSALK9-M), Version 16.12.9, RELEASE SOFTWARE (fc2)", "16.12.9")
	case "Catalyst2960S":
		catalyst(a, s, OIDCatalyst2960S, "WS-C2960S-48TS-L", "Cisco IOS Software, C2960S Software (C2960S-UNIVERSALK9-M), Version 15.2(2)E10, RELEASE SOFTWARE (fc3)", "15.2(2)E10")
	case "Nexus3064":
		nexus(a, s)
	case "Generic":
		generic(a, s)
	default:
		catalyst(a, s, OIDCatalyst2960X, "WS-C2960X-48TS-L", "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, RELEASE SOFTWARE (fc2)", "15.2(7)E8")
	}
	return a
}

func system(a *Agent, s Spec, oid, descr string) {
	a.Str(sysPrefix+".1.0", descr)
	a.OID(sysPrefix+".2.0", "."+oid)
	a.Set(sysPrefix+".3.0", Value{Type: gosnmp.TimeTicks})
	a.Str(sysPrefix+".4.0", "noc")
	a.Str(sysPrefix+".5.0", s.Name)
	a.Str(sysPrefix+".6.0", "rack")
}

// port adds one interface to IF-MIB and ifXTable.
func port(a *Agent, s Spec, idx int, name, descr string, ifType int, speedMbps uint, up bool, rate float64) {
	i := strconv.Itoa(idx)
	oper := 2
	if up {
		oper = 1
	}
	a.ports[name] = idx
	a.Str(ifTable+".2."+i, descr)
	a.Int(ifTable+".3."+i, ifType)
	sp := uint(speedMbps) * 1_000_000
	if speedMbps >= 4000 {
		sp = 4294967295
	}
	a.Gauge(ifTable+".5."+i, sp)
	a.Bytes(ifTable+".6."+i, mac(s.Name, idx))
	a.Int(ifTable+".7."+i, 1)
	a.Int(ifTable+".8."+i, oper)
	r := 0.0
	if up {
		r = rate
	}
	seed := float64(seeded(s.Name, idx) % 1_000_000)
	a.Counter32(ifTable+".10."+i, seed*1000, r)
	a.Counter32(ifTable+".13."+i, 0, 0)
	a.Counter32(ifTable+".14."+i, 0, 0)
	a.Counter32(ifTable+".16."+i, seed*700, r*0.6)
	a.Counter32(ifTable+".19."+i, 0, 0)
	a.Counter32(ifTable+".20."+i, 0, 0)
	a.Str(ifXTable+".1."+i, name)
	a.Counter64(ifXTable+".6."+i, seed*1000, r)
	a.Counter64(ifXTable+".10."+i, seed*700, r*0.6)
	a.Gauge(ifXTable+".15."+i, speedMbps)
	a.Str(ifXTable+".18."+i, "")
	if ifType == 6 {
		a.Counter32(dot3FCS+"."+i, 0, 0)
	}
}

func mac(name string, n int) []byte {
	h := seeded(name, 0)
	return []byte{0x00, 0x1b, byte(h >> 8), byte(h), byte(n >> 8), byte(n)}
}

// MACString is a model port's MAC address as text.
func MACString(name string, n int) string { return net.HardwareAddr(mac(name, n)).String() }

func catalyst(a *Agent, s Spec, oid, model, descr, version string) {
	system(a, s, oid, descr)
	members := s.Members
	if members == 0 {
		members = 1
	}
	idx := 0
	var bridgePorts []int
	for m := 1; m <= members; m++ {
		for p := 1; p <= s.Ports; p++ {
			idx++
			name := fmt.Sprintf("Gi%d/0/%d", m, p)
			up := float64(seeded(s.Name, idx)%1000)/1000 < s.Up
			port(a, s, idx, name, fmt.Sprintf("GigabitEthernet%d/0/%d", m, p), 6, 1000, up, float64(seeded(s.Name, idx)%200_000+5_000))
			if !up {
				a.Gauge(ifXTable+".15."+strconv.Itoa(idx), 10)
			}
			bridgePorts = append(bridgePorts, idx)
		}
		for u := 1; u <= s.Uplinks; u++ {
			idx++
			name := fmt.Sprintf("Te%d/1/%d", m, u)
			up := u == 1
			port(a, s, idx, name, fmt.Sprintf("TenGigabitEthernet%d/1/%d", m, u), 6, 10000, up, 4_000_000)
			bridgePorts = append(bridgePorts, idx)
			if up {
				sfp(a, idx, name)
			}
		}
	}
	// Vlan1 and a port channel: not ports, no series.
	idx++
	port(a, s, 1000+idx, "Vl1", "Vlan1", 53, 1000, true, 1000)
	for k, i := range bridgePorts {
		a.Int(basePortIf+"."+strconv.Itoa(k+1), i)
	}
	// ENTITY-MIB: a chassis per member.
	for m := 1; m <= members; m++ {
		e := strconv.Itoa(1000 * m)
		a.Str(entPhys+".2."+e, model)
		a.Int(entPhys+".5."+e, 3)
		a.Str(entPhys+".7."+e, fmt.Sprintf("Switch %d", m))
		a.Str(entPhys+".10."+e, version)
		a.Str(entPhys+".11."+e, fmt.Sprintf("FOC%08d", seeded(s.Name, m)%100_000_000))
		a.Str(entPhys+".12."+e, "Cisco Systems, Inc.")
		a.Str(entPhys+".13."+e, model)
		if s.Model == "Catalyst3850" {
			a.Int(cswInfo+".1."+e, m)
			role := 2
			switch m {
			case 1:
				role = 1
			case 2:
				role = 4
			}
			a.Int(cswInfo+".3."+e, role)
			a.Int(cswInfo+".6."+e, 4)
		}
	}
	a.Gauge(ciscoCPU+".1", uint(8+seeded(s.Name, 1)%15))
	a.Str(cempPool+".3.1.1", "Processor")
	a.Counter64(cempPool+".18.1.1", 0, 0)
	a.Set(cempPool+".18.1.1", Value{Type: gosnmp.Counter64, V: uint64(0), Base: 180_000_000})
	a.Set(cempPool+".20.1.1", Value{Type: gosnmp.Counter64, Base: 330_000_000})
	a.Str(envTemp+".2.1006", "SW#1, Sensor#1, GREEN")
	a.Gauge(envTemp+".3.1006", 38)
	a.Int(envTemp+".4.1006", 61)
	a.Int(envTemp+".6.1006", 1)
	a.Str(envFan+".2.1004", "Switch#1, Fan#1")
	a.Int(envFan+".3.1004", 1)
	a.Str(envPSU+".2.1003", "Sw1, PS1 Normal, RPS NotExist")
	a.Int(envPSU+".3.1003", 1)
	// CDP and LLDP neighbours.
	lldpPort := 0
	for _, n := range s.Neighbours {
		i := a.Port(n.Port)
		if i == 0 {
			continue
		}
		key := strconv.Itoa(i) + ".1"
		a.Bytes(cdpCache+".4."+key, net.ParseIP(n.RemoteAddr).To4())
		a.Str(cdpCache+".6."+key, n.RemoteName)
		a.Str(cdpCache+".7."+key, n.RemotePort)
		a.Str(cdpCache+".8."+key, n.Platform)
		lldpPort++
		lldpNeighbour(a, i, n)
	}
	for _, i := range bridgePorts {
		a.Str(lldpLocPort+".3."+strconv.Itoa(i), nameOf(a, i))
		a.Str(lldpLocPort+".4."+strconv.Itoa(i), descrOf(a, i))
	}
	// VLANs (CISCO-VTP-MIB) and a BRIDGE-MIB table per VLAN.
	for _, v := range s.VLANs {
		a.Int(vtpVlan+".1."+strconv.Itoa(v), 1)
	}
	for _, v := range []int{1002, 1003, 1004, 1005} {
		a.Int(vtpVlan+".1."+strconv.Itoa(v), 1)
	}
	for _, e := range s.Endpoints {
		i := a.Port(e.Port)
		if i == 0 {
			continue
		}
		va := a.VLAN(e.VLAN)
		bp := 0
		for k, b := range bridgePorts {
			if b == i {
				bp = k + 1
			}
		}
		va.Int(basePortIf+"."+strconv.Itoa(bp), i)
		hw, _ := net.ParseMAC(e.MAC)
		key := macIndex(hw)
		va.Bytes(tpFdb+".1."+key, hw)
		va.Int(tpFdb+".2."+key, bp)
		va.Int(tpFdb+".3."+key, 3)
		if e.IP != "" {
			a.Bytes(arpMedia+"."+strconv.Itoa(1000+len(bridgePorts)+1)+"."+e.IP, hw)
		}
	}
	// PoE on the first member's copper ports (the 3850-48P).
	if s.Model == "Catalyst3850" {
		for p := 1; p <= s.Ports; p++ {
			key := "1." + strconv.Itoa(p)
			draw := p%4 == 0 && float64(seeded(s.Name, p)%1000)/1000 < s.Up
			st := 2 // searching
			mw := 0
			if draw {
				st = 3
				mw = 4000 + int(seeded(s.Name, p)%9000)
			}
			a.Int(pethPort+".6."+key, st)
			a.Gauge(cpeExtPort+".9."+key, uint(mw))
		}
	}
}

func lldpNeighbour(a *Agent, local int, n Neighbour) {
	key := "0." + strconv.Itoa(local) + ".1"
	if hw, err := net.ParseMAC(n.RemoteMAC); err == nil {
		a.Bytes(lldpRem+".5."+key, hw)
	} else {
		a.Bytes(lldpRem+".5."+key, mac(n.RemoteName, 0))
	}
	a.Str(lldpRem+".7."+key, n.RemotePort)
	a.Str(lldpRem+".8."+key, n.RemotePort)
	a.Str(lldpRem+".9."+key, n.RemoteName)
	a.Str(lldpRem+".10."+key, n.Platform)
	if ip := net.ParseIP(n.RemoteAddr).To4(); ip != nil {
		a.Int(lldpManAddr+".3."+key+".1.4."+ip.String(), 2)
	}
}

func macIndex(hw net.HardwareAddr) string {
	s := ""
	for i, b := range hw {
		if i > 0 {
			s += "."
		}
		s += strconv.Itoa(int(b))
	}
	return s
}

func nameOf(a *Agent, i int) string {
	v := a.pdu(ifXTable+".1."+strconv.Itoa(i), time.Time{})
	b, _ := v.Value.([]byte)
	return string(b)
}

func descrOf(a *Agent, i int) string {
	v := a.pdu(ifTable+".2."+strconv.Itoa(i), time.Time{})
	b, _ := v.Value.([]byte)
	return string(b)
}

// sfp adds CISCO-ENTITY-SENSOR-MIB optics for a port: rx and tx power in dBm (scale units,
// precision 1) with the module's warning and alarm thresholds.
func sfp(a *Agent, ifIndex int, name string) {
	for k, what := range []string{"Receive", "Transmit"} {
		e := strconv.Itoa(5000 + ifIndex*10 + k)
		a.Str(entPhys+".7."+e, fmt.Sprintf("%s %s Power Sensor", name, what))
		a.Int(entPhys+".5."+e, 8)
		a.Int(entSensor+".1."+e, 14)
		a.Int(entSensor+".2."+e, 9)
		a.Int(entSensor+".3."+e, 1)
		val := -24 - k*-1 // -2.4 rx, -2.3 tx
		a.Int(entSensor+".4."+e, val)
		a.Int(entSensor+".5."+e, 1)
		for t, th := range []struct{ rel, val int }{{3, 10}, {4, 5}, {1, -140}, {2, -100}} {
			key := e + "." + strconv.Itoa(t+1)
			a.Int(entSensThr+".2."+key, 20)
			rel := th.rel
			if rel == 2 {
				rel = 1
			}
			if t == 0 {
				rel = 3
			}
			a.Int(entSensThr+".3."+key, rel)
			a.Int(entSensThr+".4."+key, th.val)
		}
	}
}

func nexus(a *Agent, s Spec) {
	system(a, s, OIDNexus3064, "Cisco NX-OS(tm) n3000, Software (n3000-uk9), Version 7.0(3)I7(9), RELEASE SOFTWARE Copyright (c) 2002-2020 by Cisco Systems, Inc.")
	idx := 436207616 // NX-OS's ifIndex for Ethernet1/1
	var phys []int
	for p := 1; p <= s.Ports+s.Uplinks; p++ {
		speed := uint(10000)
		if p > s.Ports {
			speed = 40000
		}
		up := float64(seeded(s.Name, p)%1000)/1000 < s.Up
		i := idx + (p-1)*4096
		port(a, s, i, fmt.Sprintf("Ethernet1/%d", p), fmt.Sprintf("Ethernet1/%d", p), 6, speed, up, 20_000_000)
		phys = append(phys, i)
	}
	for k, i := range phys {
		a.Int(basePortIf+"."+strconv.Itoa(k+1), i)
		a.Str(lldpLocPort+".3."+strconv.Itoa(i), nameOf(a, i))
		a.Str(lldpLocPort+".4."+strconv.Itoa(i), descrOf(a, i))
		a.Gauge(qPvid+"."+strconv.Itoa(k+1), 1)
	}
	a.Str(entPhys+".2.10", "Nexus 3064 Chassis")
	a.Int(entPhys+".5.10", 3)
	a.Str(entPhys+".7.10", "Nexus3064 Chassis")
	a.Str(entPhys+".10.10", "7.0(3)I7(9)")
	a.Str(entPhys+".11.10", fmt.Sprintf("FOC%08d", seeded(s.Name, 9)%100_000_000))
	a.Str(entPhys+".13.10", "N3K-C3064PQ-10GX")
	for k := 0; k < 4; k++ {
		e := strconv.Itoa(534 + k)
		a.Str(entPhys+".7."+e, fmt.Sprintf("Fan Module-%d", k+1))
		a.Int(entPhys+".5."+e, 7)
		a.Int(cefcFan+"."+e, 2)
	}
	for k := 0; k < 2; k++ {
		e := strconv.Itoa(470 + k)
		a.Str(entPhys+".7."+e, fmt.Sprintf("PowerSupply-%d", k+1))
		a.Int(entPhys+".5."+e, 6)
		a.Int(cefcPower+"."+e, 2)
	}
	a.Gauge(ciscoCPU+".1", 11)
	a.Gauge(cseMem, 47)
	// Temperatures from ENTITY-SENSOR (celsius).
	for k, n := range []string{"Front", "Back", "CPU"} {
		e := strconv.Itoa(21590 + k)
		a.Str(entPhys+".7."+e, n+" temperature")
		a.Int(entSensor+".1."+e, 8)
		a.Int(entSensor+".2."+e, 9)
		a.Int(entSensor+".3."+e, 0)
		a.Int(entSensor+".4."+e, 30+k*8)
		a.Int(entSensor+".5."+e, 1)
	}
	for _, n := range s.Neighbours {
		i := a.Port(n.Port)
		if i == 0 {
			continue
		}
		key := strconv.Itoa(i) + ".1"
		a.Bytes(cdpCache+".4."+key, net.ParseIP(n.RemoteAddr).To4())
		a.Str(cdpCache+".6."+key, n.RemoteName)
		a.Str(cdpCache+".7."+key, n.RemotePort)
		a.Str(cdpCache+".8."+key, n.Platform)
		lldpNeighbour(a, i, n)
	}
	for _, e := range s.Endpoints {
		i := a.Port(e.Port)
		bp := 0
		for k, b := range phys {
			if b == i {
				bp = k + 1
			}
		}
		if bp == 0 {
			continue
		}
		hw, _ := net.ParseMAC(e.MAC)
		key := strconv.Itoa(max(e.VLAN, 1)) + "." + macIndex(hw)
		a.Int(qTpFdb+".2."+key, bp)
		a.Int(qTpFdb+".3."+key, 3)
		if e.IP != "" {
			a.Bytes(arpMedia+".1."+e.IP, hw)
		}
	}
}

func generic(a *Agent, s Spec) {
	system(a, s, OIDNetSNMPLinux, "Linux "+s.Name+" 5.10.60 #1 SMP x86_64")
	for p := 1; p <= max(s.Ports, 1); p++ {
		port(a, s, p+1, fmt.Sprintf("eth%d", p-1), fmt.Sprintf("eth%d", p-1), 6, 1000, true, 50_000)
	}
	a.Int(hrProc+".196608", 12)
	a.Int(hrProc+".196609", 18)
	a.OID(hrStorage+".2.1", ".1.3.6.1.2.1.25.2.1.2")
	a.Str(hrStorage+".3.1", "Physical memory")
	a.Int(hrStorage+".4.1", 1024)
	a.Int(hrStorage+".5.1", 4_000_000)
	a.Int(hrStorage+".6.1", 1_500_000)
	for _, n := range s.Neighbours {
		if i := a.Port(n.Port); i > 0 {
			lldpNeighbour(a, i, n)
			a.Str(lldpLocPort+".3."+strconv.Itoa(i), n.Port)
		}
	}
}
