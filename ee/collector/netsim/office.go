// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import "fmt"

// Office is the small network the tests and the live demo use: a MikroTik router (served by
// the RouterOS fake), a Nexus core, two access switches (one a stack of two 3850s), and the
// servers and nodes behind them. Names are generic samples.
func Office(nodes []Endpoint) []Spec {
	core := Spec{
		Name: "core-1", Model: "Nexus3064", Ports: 48, Uplinks: 4, Up: 0.15, Address: "10.0.0.2",
		Neighbours: []Neighbour{
			{Port: "Ethernet1/1", RemoteName: "edge-1", RemotePort: "sfp-sfpplus1", RemoteAddr: "10.0.0.1", Platform: "MikroTik RouterOS"},
			{Port: "Ethernet1/47", RemoteName: "sw-access-1", RemotePort: "Te1/1/1", RemoteAddr: "10.0.0.11", Platform: "cisco WS-C2960X-48TS-L"},
			{Port: "Ethernet1/48", RemoteName: "sw-access-2", RemotePort: "Te1/1/1", RemoteAddr: "10.0.0.12", Platform: "cisco WS-C3850-48P"},
		},
	}
	a1 := Spec{
		Name: "sw-access-1", Model: "Catalyst2960X", Ports: 48, Uplinks: 4, Up: 0.5, Address: "10.0.0.11",
		Neighbours: []Neighbour{{Port: "Te1/1/1", RemoteName: "core-1", RemotePort: "Ethernet1/47", RemoteAddr: "10.0.0.2", Platform: "N3K-C3064PQ-10GX"}},
	}
	a2 := Spec{
		Name: "sw-access-2", Model: "Catalyst3850", Ports: 48, Uplinks: 4, Members: 2, Up: 0.4, Address: "10.0.0.12",
		VLANs:      []int{1, 10, 20, 150},
		Neighbours: []Neighbour{{Port: "Te1/1/1", RemoteName: "core-1", RemotePort: "Ethernet1/48", RemoteAddr: "10.0.0.2", Platform: "N3K-C3064PQ-10GX"}},
	}
	for i, n := range nodes {
		if i%2 == 0 {
			n.Port = fmt.Sprintf("Gi1/0/%d", 14+i)
			a2.Endpoints = append(a2.Endpoints, n)
		} else {
			n.Port = fmt.Sprintf("Gi1/0/%d", 3+i)
			a1.Endpoints = append(a1.Endpoints, n)
		}
	}
	// Desks and printers: unknown endpoints.
	for k := 0; k < 12; k++ {
		e := Endpoint{MAC: fmt.Sprintf("3c:52:82:00:10:%02x", k), VLAN: 20, IP: fmt.Sprintf("10.0.20.%d", 50+k)}
		if k%2 == 0 {
			e.Port = fmt.Sprintf("Gi1/0/%d", 30+k)
			a1.Endpoints = append(a1.Endpoints, e)
		} else {
			e.Port = fmt.Sprintf("Gi2/0/%d", 30+k)
			a2.Endpoints = append(a2.Endpoints, e)
		}
	}
	// 0.17: the NAS and a UPS behind sw-access-1, the recorder and two APs behind
	// sw-access-2 (ap-warehouse hangs off ap-office over Wi-Fi).
	a1.Endpoints = append(a1.Endpoints,
		Endpoint{Port: "Gi1/0/20", MAC: MACString("nas-1", 2), VLAN: 10, IP: "10.0.10.40"},
		Endpoint{Port: "Gi1/0/21", MAC: MACString("ups-1", 2), VLAN: 10, IP: "10.0.10.41"},
	)
	a2.Endpoints = append(a2.Endpoints,
		Endpoint{Port: "Gi1/0/40", MAC: NVRMAC, VLAN: 10, IP: "10.0.10.50"},
		Endpoint{Port: "Gi1/0/44", MAC: simAPs[0].mac, VLAN: 150, IP: simAPs[0].addr},
		Endpoint{Port: "Gi1/0/46", MAC: simAPs[1].mac, VLAN: 150, IP: simAPs[1].addr},
	)
	return []Spec{core, a1, a2, {Name: "nas-1", Model: "QNAP"}, {Name: "ups-1", Model: "UPS"}}
}

// NVRMAC is the simulated recorder's own MAC address (its network config says so).
const NVRMAC = "3c:ef:8c:00:00:01"

// Fleet is n 52-port access switches (48 copper, 4 SFP+), the budget run's load.
func Fleet(n int) []Spec {
	out := make([]Spec, n)
	for i := range out {
		eps := make([]Endpoint, 0, 30)
		for k := 0; k < 30; k++ {
			eps = append(eps, Endpoint{Port: fmt.Sprintf("Gi1/0/%d", k+1), MAC: fmt.Sprintf("02:%02x:00:00:%02x:%02x", i, k/256, k%256), VLAN: 10 + k%3*10})
		}
		out[i] = Spec{
			Name: fmt.Sprintf("sw-%02d", i+1), Model: "Catalyst2960X", Ports: 48, Uplinks: 4, Up: 0.7,
			Address:    fmt.Sprintf("10.1.%d.%d", i/250, i%250+1),
			Neighbours: []Neighbour{{Port: "Te1/1/1", RemoteName: "core-1", RemotePort: fmt.Sprintf("Ethernet1/%d", i+1), RemoteAddr: "10.0.0.2"}},
			Endpoints:  eps,
		}
	}
	return out
}
