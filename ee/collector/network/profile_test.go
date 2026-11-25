// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import "testing"

func TestProfilesLoadAndMatch(t *testing.T) {
	ps, err := LoadProfiles()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"generic", "cisco-ios", "cisco-nxos", "mikrotik", "qnap", "ups-mib", "apc-ups"} {
		if ps[n] == nil {
			t.Fatalf("profile %s missing", n)
		}
	}
	cases := []struct{ oid, descr, want string }{
		// Catalysts on classic IOS and on IOS XE: under ciscoProducts.
		{"1.3.6.1.4.1.9.1.2780", "Cisco IOS Software, C1000 Software (C1000-UNIVERSALK9-M), Version 15.2(7)E8", "cisco-ios"},
		{"1.3.6.1.4.1.9.1.2494", "Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE-M), Version 16.12.9", "cisco-ios"},
		{"1.3.6.1.4.1.9.12.3.1.3.1508", "Cisco NX-OS(tm) nxos.9.3.13.bin, Software (nxos), Version 9.3(13)", "cisco-nxos"},
		{".1.3.6.1.4.1.14988.1", "RouterOS CCR2116-12G-4S+", "mikrotik"},
		{"1.3.6.1.4.1.8072.3.2.10", "Linux nas-1 5.10.60-qnap", "qnap"},
		{"1.3.6.1.4.1.8072.3.2.10", "Linux web-1 6.1.0", "generic"},
		{"1.3.6.1.4.1.318.1.3.27", "APC Web/SNMP Management Card", "apc-ups"},
	}
	for _, c := range cases {
		if got := ps.For(c.oid, c.descr); got.Name != c.want {
			t.Errorf("%s %q → %s, want %s", c.oid, c.descr, got.Name, c.want)
		}
	}
	// Extending: the Nexus keeps Catalyst's CPU and CDP, replaces memory and fans.
	nx := ps["cisco-nxos"]
	if len(nx.CPU) == 0 || nx.CPU[0].OID != ps["cisco-ios"].CPU[0].OID {
		t.Fatal("NX-OS keeps the Catalyst CPU")
	}
	if nx.Memory[0].Percent == "" || nx.Interfaces == nil || nx.Interfaces.HCInOctets == "" {
		t.Fatal("NX-OS memory as a percentage, interfaces from generic")
	}
	if ps["mikrotik"].RouterOS == nil || ps["mikrotik"].RouterOS.Resource == "" {
		t.Fatal("mikrotik lists its RouterOS menus")
	}
	if ps["cisco-ios"].MACs.PerVLAN != "cisco" {
		t.Fatal("IOS reads MAC tables per VLAN")
	}
}
