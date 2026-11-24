// SPDX-License-Identifier: AGPL-3.0-only

// Package nics reads a host's network cards: each physical port's and bond's name, MAC
// address, IPv4 addresses, speed and link state (ADR-233). The network module matches them to
// the MAC and ARP tables of the switches, so a server or a node shows the switch port it is
// on. Read from the host's /sys and /proc (under /host on Kubernetes), never through the
// container's own network namespace; harmless in Community, where nothing reads them.
package nics

import (
	"bufio"
	"encoding/hex"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// NIC is one network card as the inventory sends it.
type NIC struct {
	Name      string   `json:"name"`
	MAC       string   `json:"mac"`
	Addresses []string `json:"addresses,omitempty"`
	SpeedMbps int      `json:"speedMbps,omitempty"`
	Up        bool     `json:"up"`
}

// MaxNICs bounds what is sent.
const MaxNICs = 32

// Read lists the physical ports and bonds under sysRoot/class/net, with the IPv4 addresses
// the host's network namespace (procRoot/1/net) has on each.
func Read(sysRoot, procRoot string) []NIC {
	base := filepath.Join(sysRoot, "class", "net")
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	addrs := ipv4ByIface(procRoot)
	// A node or server that is itself a container (kind, k3d, LXC) has no physical port: its
	// default route's interface is the one a switch sees (its veth's MAC on the bridge).
	keep := map[string]bool{}
	for _, e := range entries {
		if physical(filepath.Join(base, e.Name()), e.Name()) {
			keep[e.Name()] = true
		}
	}
	if len(keep) == 0 {
		if d := defaultIface(procRoot); d != "" {
			keep[d] = true
		}
	}
	var out []NIC
	for _, e := range entries {
		name := e.Name()
		dir := filepath.Join(base, name)
		if !keep[name] {
			continue
		}
		mac := strings.TrimSpace(readFile(filepath.Join(dir, "address")))
		if !validMAC(mac) {
			continue
		}
		n := NIC{Name: name, MAC: strings.ToLower(mac), Addresses: addrs[name]}
		n.Up = strings.TrimSpace(readFile(filepath.Join(dir, "operstate"))) == "up"
		if s, err := strconv.Atoi(strings.TrimSpace(readFile(filepath.Join(dir, "speed")))); err == nil && s > 0 {
			n.SpeedMbps = s
		}
		out = append(out, n)
		if len(out) == MaxNICs {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// defaultIface is the interface of the IPv4 default route (” when there is none).
func defaultIface(procRoot string) string {
	for i, line := range strings.Split(readFile(filepath.Join(procRoot, "1", "net", "route")), "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 2 {
			continue
		}
		if f[1] == "00000000" {
			return f[0]
		}
	}
	return ""
}

// physical keeps ports with a device behind them and bonds; containers' veths, bridges,
// tunnels and the loopback have no device link.
func physical(dir, name string) bool {
	if name == "lo" {
		return false
	}
	if _, err := os.Stat(filepath.Join(dir, "bonding")); err == nil {
		return true
	}
	fi, err := os.Lstat(filepath.Join(dir, "device"))
	return err == nil && fi.Mode()&fs.ModeSymlink != 0
}

func validMAC(s string) bool {
	hw, err := net.ParseMAC(s)
	if err != nil || len(hw) != 6 {
		return false
	}
	for _, b := range hw {
		if b != 0 {
			return true
		}
	}
	return false
}

func readFile(p string) string {
	b, err := os.ReadFile(p) //nolint:gosec // G304: files under the host's /sys and /proc, by design
	if err != nil {
		return ""
	}
	return string(b)
}

// ipv4ByIface maps each interface to its local IPv4 addresses: the LOCAL host entries of the
// host's fib_trie, each put on the interface whose route covers it.
func ipv4ByIface(procRoot string) map[string][]string {
	locals := localAddrs(readFile(filepath.Join(procRoot, "1", "net", "fib_trie")))
	routes := parseRoutes(readFile(filepath.Join(procRoot, "1", "net", "route")))
	out := map[string][]string{}
	for _, ip := range locals {
		best, bestOnes := "", -1
		for _, r := range routes {
			if r.dest.Contains(ip) {
				if ones, _ := r.dest.Mask.Size(); ones > bestOnes && r.dest.IP.To4() != nil && !r.dest.IP.Equal(net.IPv4zero) {
					best, bestOnes = r.iface, ones
				}
			}
		}
		if best != "" && !contains(out[best], ip.String()) {
			out[best] = append(out[best], ip.String())
		}
	}
	for k := range out {
		sort.Strings(out[k])
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// localAddrs reads the "/32 host LOCAL" leaves of /proc/net/fib_trie.
func localAddrs(trie string) []net.IP {
	var out []net.IP
	var last net.IP
	sc := bufio.NewScanner(strings.NewReader(trie))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "|-- ") {
			last = net.ParseIP(strings.TrimPrefix(line, "|-- ")).To4()
			continue
		}
		if line == "/32 host LOCAL" && last != nil && !last.IsLoopback() {
			dup := false
			for _, x := range out {
				if x.Equal(last) {
					dup = true
				}
			}
			if !dup {
				out = append(out, last)
			}
		}
	}
	return out
}

type route struct {
	iface string
	dest  *net.IPNet
}

// parseRoutes reads /proc/net/route: interface, destination and mask in little-endian hex.
func parseRoutes(text string) []route {
	var out []route
	sc := bufio.NewScanner(strings.NewReader(text))
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 8 {
			continue
		}
		dst, err1 := leIP(f[1])
		mask, err2 := leIP(f[7])
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, route{iface: f[0], dest: &net.IPNet{IP: dst.Mask(net.IPMask(mask)), Mask: net.IPMask(mask)}})
	}
	return out
}

func leIP(h string) (net.IP, error) {
	b, err := hex.DecodeString(h)
	if err != nil || len(b) != 4 {
		return nil, fs.ErrInvalid
	}
	return net.IPv4(b[3], b[2], b[1], b[0]).To4(), nil
}
