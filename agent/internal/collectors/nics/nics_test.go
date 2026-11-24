// SPDX-License-Identifier: AGPL-3.0-only

package nics

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

const fibTrie = `Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
     +-- 10.0.10.0/24 2 0 2
        |-- 10.0.10.0
           /24 link UNICAST
        |-- 10.0.10.21
           /32 host LOCAL
     +-- 127.0.0.0/8 2 0 2
        |-- 127.0.0.1
           /32 host LOCAL
Local:
  +-- 10.0.10.0/24 2 0 2
        |-- 10.0.10.21
           /32 host LOCAL
`

// Iface Destination Gateway Flags RefCnt Use Metric Mask ...
const routes = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eno1	00000000	010A000A	0003	0	0	0	00000000	0	0	0
eno1	000A000A	00000000	0001	0	0	0	00FFFFFF	0	0	0
docker0	000011AC	00000000	0001	0	0	0	0000FFFF	0	0	0
`

func TestRead(t *testing.T) {
	root := t.TempDir()
	sys, proc := filepath.Join(root, "sys"), filepath.Join(root, "proc")
	net := filepath.Join(sys, "class", "net")
	// A physical port: a device link.
	write(t, filepath.Join(net, "eno1", "address"), "3C:EC:EF:12:34:56\n")
	write(t, filepath.Join(net, "eno1", "operstate"), "up\n")
	write(t, filepath.Join(net, "eno1", "speed"), "1000\n")
	if err := os.Symlink("../../devices/pci0000:00/0000:00:19.0", filepath.Join(net, "eno1", "device")); err != nil {
		t.Fatal(err)
	}
	// A bond.
	write(t, filepath.Join(net, "bond0", "address"), "3c:ec:ef:00:00:01\n")
	write(t, filepath.Join(net, "bond0", "operstate"), "down\n")
	write(t, filepath.Join(net, "bond0", "bonding", "mode"), "802.3ad 4\n")
	// A container's veth, a bridge and the loopback: no device.
	write(t, filepath.Join(net, "veth1a2b", "address"), "aa:bb:cc:dd:ee:01\n")
	write(t, filepath.Join(net, "docker0", "address"), "02:42:ac:11:00:01\n")
	write(t, filepath.Join(net, "lo", "address"), "00:00:00:00:00:00\n")
	write(t, filepath.Join(proc, "1", "net", "fib_trie"), fibTrie)
	write(t, filepath.Join(proc, "1", "net", "route"), routes)

	got := Read(sys, proc)
	want := []NIC{
		{Name: "bond0", MAC: "3c:ec:ef:00:00:01", Up: false},
		{Name: "eno1", MAC: "3c:ec:ef:12:34:56", Addresses: []string{"10.0.10.21"}, SpeedMbps: 1000, Up: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Read = %+v\nwant %+v", got, want)
	}
	if Read(filepath.Join(root, "nowhere"), proc) != nil {
		t.Fatal("a missing /sys gives nothing")
	}
}

// A node that is a container (k3d, kind): no physical port, so its default route's veth.
func TestReadContainerNode(t *testing.T) {
	sys, proc := t.TempDir(), t.TempDir()
	net := filepath.Join(sys, "class", "net")
	write(t, filepath.Join(net, "eth0", "address"), "02:42:ac:12:00:03\n")
	write(t, filepath.Join(net, "eth0", "operstate"), "up\n")
	write(t, filepath.Join(net, "cni0", "address"), "02:42:ac:12:00:99\n")
	write(t, filepath.Join(net, "lo", "address"), "00:00:00:00:00:00\n")
	write(t, filepath.Join(proc, "1", "net", "route"), "Iface\tDestination\tGateway\nethX\t000011AC\t00000000\neth0\t00000000\t010012AC\n")
	got := Read(sys, proc)
	if len(got) != 1 || got[0].Name != "eth0" || got[0].MAC != "02:42:ac:12:00:03" || !got[0].Up {
		t.Fatalf("got %+v", got)
	}
}
