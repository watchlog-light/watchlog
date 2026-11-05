// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Fixtures were captured from a Lima Ubuntu 24.04 arm64 VM (kernel 6.8, cgroup v2)
// via the host's /proc/1 view, as the agent sees it with --pid host (ADR-023).
const fixture = "testdata/ubuntu-24.04-arm64"

// dfStatfs answers statfs from the df -B1 output captured with the fixture.
func dfStatfs(t *testing.T, calls *[]string) func(string) (fsUsage, error) {
	t.Helper()
	f, err := os.Open(filepath.Join(fixture, "df.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	usage := map[string]fsUsage{}
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		fl := strings.Fields(sc.Text())
		size, _ := strconv.ParseFloat(fl[2], 64)
		used, _ := strconv.ParseFloat(fl[3], 64)
		avail, _ := strconv.ParseFloat(fl[4], 64)
		usage[fl[0]] = fsUsage{size: size, free: size - used, avail: avail}
	}
	return func(path string) (fsUsage, error) {
		*calls = append(*calls, path)
		u, ok := usage[strings.TrimPrefix(path, "/rootfs")]
		if !ok && path == "/rootfs" {
			u, ok = usage["/"]
		}
		if !ok {
			return fsUsage{}, errors.New("no df entry for " + path)
		}
		return u, nil
	}
}

func newTestCollector(t *testing.T, calls *[]string) *Collector {
	c := New(Config{ProcRoot: "/proc", SysRoot: "/sys", RootFS: "/rootfs"})
	c.fsys = os.DirFS(fixture)
	c.statfs = dfStatfs(t, calls)
	return c
}

func index(samples []metrics.Sample) map[string]float64 {
	out := map[string]float64{}
	for _, s := range samples {
		var parts []string
		for _, l := range s.Labels {
			parts = append(parts, l.Name+"="+l.Value)
		}
		out[s.Name+"{"+strings.Join(parts, ",")+"}"] = s.Value
	}
	return out
}

func TestCollectFromRealFixture(t *testing.T) {
	var statfsCalls []string
	samples, err := newTestCollector(t, &statfsCalls).Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	got := index(samples)

	want := map[string]float64{
		"watchlog_node_cpu_count{}":                                  4,
		"watchlog_node_boot_time_seconds{}":                          1793403752,
		"watchlog_node_cpu_seconds_total{mode=user}":                 18.80,
		"watchlog_node_cpu_seconds_total{mode=idle}":                 292.21,
		"watchlog_node_cpu_seconds_total{mode=steal}":                0,
		"watchlog_node_memory_bytes{state=total}":                    3999088 * 1024,
		"watchlog_node_memory_bytes{state=available}":                3604996 * 1024,
		"watchlog_node_memory_bytes{state=swap_total}":               0,
		"watchlog_node_load1{}":                                      0.26,
		"watchlog_node_load15{}":                                     0.04,
		"watchlog_node_disk_io_bytes_total{dev=vda,dir=read}":        774070 * 512,
		"watchlog_node_disk_io_bytes_total{dev=vda,dir=write}":       4784916 * 512,
		"watchlog_node_disk_io_bytes_total{dev=vdb,dir=read}":        44272 * 512,
		"watchlog_node_network_bytes_total{iface=eth0,dir=rx}":       136009833,
		"watchlog_node_network_bytes_total{iface=eth0,dir=tx}":       898515,
		"watchlog_node_filesystem_bytes{mount=/,state=size}":         30083776512,
		"watchlog_node_filesystem_bytes{mount=/,state=avail}":        27493769216,
		"watchlog_node_filesystem_bytes{mount=/boot/efi,state=size}": 102185984,
	}
	for k, v := range want {
		if g, ok := got[k]; !ok {
			t.Errorf("missing %s", k)
		} else if diff := g - v; diff > 1e-6 || diff < -1e-6 {
			t.Errorf("%s = %v, want %v", k, g, v)
		}
	}

	for k := range got {
		for _, excluded := range []string{"dev=loop", "dev=vda1", "iface=lo", "iface=docker0", "iface=veth", "virtiofs", "/Users/", "/tmp/lima", "efivars", "lima-cidata"} {
			if strings.Contains(k, excluded) {
				t.Errorf("unexpected series %s", k)
			}
		}
	}

	wantStatfs := []string{"/rootfs", "/rootfs/boot", "/rootfs/boot/efi"}
	if strings.Join(statfsCalls, " ") != strings.Join(wantStatfs, " ") {
		t.Errorf("statfs calls = %v, want %v", statfsCalls, wantStatfs)
	}
}

func TestCollectReturnsPartialResultsOnErrors(t *testing.T) {
	var calls []string
	c := newTestCollector(t, &calls)
	c.cfg.ProcRoot = "/missing-proc"
	samples, err := c.Collect()
	if err == nil {
		t.Fatal("expected an error for the missing procfs")
	}
	if len(samples) != 0 {
		t.Errorf("got %d samples from a missing procfs", len(samples))
	}

	c = newTestCollector(t, &calls)
	c.statfs = func(string) (fsUsage, error) { return fsUsage{}, errors.New("boom") }
	samples, err = c.Collect()
	if err == nil || !strings.Contains(err.Error(), "statfs") {
		t.Fatalf("expected a statfs error, got %v", err)
	}
	if index(samples)["watchlog_node_load1{}"] != 0.26 {
		t.Error("other collectors should still report when statfs fails")
	}
}

func TestParseMountinfoUnescapesPaths(t *testing.T) {
	in := `36 25 0:32 / /mnt/my\040disk rw,relatime shared:1 - ext4 /dev/sdb1 rw`
	m, err := parseMountinfo(strings.NewReader(in))
	if err != nil || len(m) != 1 || m[0].mountPoint != "/mnt/my disk" || m[0].fsType != "ext4" {
		t.Fatalf("parseMountinfo = %+v, %v", m, err)
	}
}

func TestParseErrors(t *testing.T) {
	if _, err := parseStat(strings.NewReader("intr 1 2 3\n")); err == nil {
		t.Error("parseStat: expected error without a cpu line")
	}
	if _, err := parseLoadavg(strings.NewReader("0.1\n")); err == nil {
		t.Error("parseLoadavg: expected error for short input")
	}
	if _, err := parseNetDev(strings.NewReader("eth0: 1 2\n"), keepIface); err == nil {
		t.Error("parseNetDev: expected error for short line")
	}
}

func BenchmarkCollect(b *testing.B) {
	c := New(Config{ProcRoot: "/proc", SysRoot: "/sys", RootFS: "/rootfs"})
	c.fsys = os.DirFS(fixture)
	c.statfs = func(string) (fsUsage, error) { return fsUsage{size: 1, free: 1, avail: 1}, nil }
	b.ReportAllocs()
	for b.Loop() {
		if _, err := c.Collect(); err != nil {
			b.Fatal(err)
		}
	}
}
