// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// userHZ is the kernel's USER_HZ; /proc/stat counts CPU time in these ticks.
const userHZ = 100

// cpuModes are the /proc/stat "cpu" columns, in order.
var cpuModes = []string{"user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"}

type cpuStat struct {
	seconds map[string]float64
	count   int
	// bootTime is the "btime" line: when the host booted, in Unix seconds (0 if absent).
	bootTime float64
}

// parseStat reads the aggregate "cpu" line and counts per-CPU lines.
func parseStat(r io.Reader) (cpuStat, error) {
	out := cpuStat{seconds: map[string]float64{}}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	found := false
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && fields[0] == "btime" {
			if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				out.bootTime = float64(v)
			}
			continue
		}
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "cpu") {
			continue
		}
		if fields[0] != "cpu" {
			out.count++
			continue
		}
		found = true
		for i, mode := range cpuModes {
			if i+1 >= len(fields) {
				break
			}
			v, err := strconv.ParseUint(fields[i+1], 10, 64)
			if err != nil {
				return out, fmt.Errorf("stat: %s: %w", mode, err)
			}
			out.seconds[mode] = float64(v) / userHZ
		}
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	if !found {
		return out, fmt.Errorf("stat: no aggregate cpu line")
	}
	return out, nil
}

// parseMeminfo returns the values in bytes, keyed by field name.
func parseMeminfo(r io.Reader) (map[string]float64, error) {
	out := map[string]float64{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseFloat(fields[0], 64)
		if err != nil {
			return nil, fmt.Errorf("meminfo: %s: %w", name, err)
		}
		if len(fields) > 1 && fields[1] == "kB" {
			v *= 1024
		}
		out[name] = v
	}
	return out, sc.Err()
}

// parseLoadavg returns the 1, 5 and 15 minute load averages.
func parseLoadavg(r io.Reader) ([3]float64, error) {
	var out [3]float64
	b, err := io.ReadAll(r)
	if err != nil {
		return out, err
	}
	fields := strings.Fields(string(b))
	if len(fields) < 3 {
		return out, fmt.Errorf("loadavg: too few fields")
	}
	for i := range out {
		if out[i], err = strconv.ParseFloat(fields[i], 64); err != nil {
			return out, fmt.Errorf("loadavg: %w", err)
		}
	}
	return out, nil
}

type diskIO struct {
	device       string
	readBytes    float64
	writtenBytes float64
}

// parseDiskstats returns read/written bytes for devices accepted by keep.
// Fields (Documentation/admin-guide/iostats.rst): 3 name, 6 sectors read, 10 sectors written.
func parseDiskstats(r io.Reader, keep func(device string) bool) ([]diskIO, error) {
	const sectorBytes = 512
	var out []diskIO
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 || !keep(f[2]) {
			continue
		}
		read, err1 := strconv.ParseFloat(f[5], 64)
		written, err2 := strconv.ParseFloat(f[9], 64)
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("diskstats: bad counters for %s", f[2])
		}
		out = append(out, diskIO{device: f[2], readBytes: read * sectorBytes, writtenBytes: written * sectorBytes})
	}
	return out, sc.Err()
}

type netIO struct {
	iface   string
	rxBytes float64
	txBytes float64
}

// parseNetDev returns rx/tx bytes for interfaces accepted by keep.
func parseNetDev(r io.Reader, keep func(iface string) bool) ([]netIO, error) {
	var out []netIO
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue // the two header lines
		}
		name = strings.TrimSpace(name)
		if !keep(name) {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			return nil, fmt.Errorf("net/dev: too few fields for %s", name)
		}
		rx, err1 := strconv.ParseFloat(f[0], 64)
		tx, err2 := strconv.ParseFloat(f[8], 64)
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("net/dev: bad counters for %s", name)
		}
		out = append(out, netIO{iface: name, rxBytes: rx, txBytes: tx})
	}
	return out, sc.Err()
}

type mount struct {
	device     string // major:minor
	mountPoint string
	fsType     string
}

// parseMountinfo reads /proc/<pid>/mountinfo (see proc(5)).
func parseMountinfo(r io.Reader) ([]mount, error) {
	var out []mount
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		left, right, ok := strings.Cut(sc.Text(), " - ")
		if !ok {
			continue
		}
		lf, rf := strings.Fields(left), strings.Fields(right)
		if len(lf) < 5 || len(rf) < 1 {
			continue
		}
		out = append(out, mount{device: lf[2], mountPoint: unescapeOctal(lf[4]), fsType: rf[0]})
	}
	return out, sc.Err()
}

// unescapeOctal decodes the \040-style escapes the kernel uses in mount paths.
func unescapeOctal(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
