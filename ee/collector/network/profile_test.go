// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import "testing"

func TestProfilesLoadAndMatch(t *testing.T) {
	ps, err := LoadProfiles()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"generic", "cisco-ios", "cisco-nxos", "mikrotik"} {
		if ps[n] == nil {
			t.Fatalf("profile %s missing", n)
		}
	}
	cases := []struct{ oid, descr, want string }{
		// Catalyst 2960X-48TS-L, 2960-Plus, 3850-48P: under ciscoProducts.
		{"1.3.6.1.4.1.9.1.1208", "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8", "cisco-ios"},
		{"1.3.6.1.4.1.9.1.2134", "Cisco IOS Software [Amsterdam], Catalyst L3 Switch Software (CAT3K_CAA-UNIVERSALK9-M), Version 16.12.9", "cisco-ios"},
		{"1.3.6.1.4.1.9.12.3.1.3.1106", "Cisco NX-OS(tm) n3000, Software (n3000-uk9), Version 7.0(3)I7(9)", "cisco-nxos"},
		{".1.3.6.1.4.1.14988.1", "RouterOS CCR2004-16G-2S+", "mikrotik"},
		{"1.3.6.1.4.1.8072.3.2.10", "Linux nas-1 5.10.60-qnap", "generic"},
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
