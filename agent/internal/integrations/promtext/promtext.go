// SPDX-License-Identifier: AGPL-3.0-only

// Package promtext reads the Prometheus text exposition format (version 0.0.4), as
// services that expose their own metrics write it (ingress-nginx on :10254,
// rabbitmq_prometheus on :15692). Only what an integration keeps is parsed: families
// are chosen by name before their labels are read, and a line that doesn't parse is
// skipped, never fatal.
package promtext

import (
	"bufio"
	"io"
	"math"
	"strconv"
	"strings"
)

// Sample is one line: a metric name, its labels and value.
type Sample struct {
	Name   string
	Labels map[string]string
	Value  float64
}

// MaxLine bounds one line; longer ones are skipped (a label value can't be that big in
// anything an integration keeps).
const MaxLine = 64 << 10

// Parse reads r and returns the samples whose name keep accepts. Comments, blank lines
// and lines that don't parse are skipped. NaN values are dropped.
func Parse(r io.Reader, keep func(name string) bool) ([]Sample, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), MaxLine)
	var out []Sample
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == '#' {
			continue
		}
		end := strings.IndexAny(line, "{ \t")
		if end <= 0 {
			continue
		}
		name := line[:end]
		if !keep(name) {
			continue
		}
		s, ok := parseLine(name, line[end:])
		if ok {
			out = append(out, s)
		}
	}
	if err := sc.Err(); err != nil && err != bufio.ErrTooLong {
		return out, err
	}
	return out, nil
}

func parseLine(name, rest string) (Sample, bool) {
	s := Sample{Name: name}
	if strings.HasPrefix(rest, "{") {
		labels, n, ok := parseLabels(rest[1:])
		if !ok {
			return s, false
		}
		s.Labels = labels
		rest = rest[1+n:]
	}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return s, false
	}
	v, err := parseValue(fields[0])
	if err != nil || math.IsNaN(v) {
		return s, false
	}
	s.Value = v
	return s, true
}

func parseValue(f string) (float64, error) {
	switch f {
	case "+Inf":
		return math.Inf(1), nil
	case "-Inf":
		return math.Inf(-1), nil
	}
	return strconv.ParseFloat(f, 64)
}

// parseLabels reads `a="x",b="y"}` and returns the labels and the bytes consumed,
// including the closing brace.
func parseLabels(s string) (map[string]string, int, bool) {
	labels := map[string]string{}
	i := 0
	for {
		for i < len(s) && (s[i] == ' ' || s[i] == ',') {
			i++
		}
		if i >= len(s) {
			return nil, 0, false
		}
		if s[i] == '}' {
			return labels, i + 1, true
		}
		eq := strings.IndexByte(s[i:], '=')
		if eq <= 0 || i+eq+1 >= len(s) || s[i+eq+1] != '"' {
			return nil, 0, false
		}
		key := strings.TrimSpace(s[i : i+eq])
		i += eq + 2
		var b strings.Builder
		closed := false
		for i < len(s) {
			c := s[i]
			if c == '\\' && i+1 < len(s) {
				switch s[i+1] {
				case 'n':
					b.WriteByte('\n')
				default:
					b.WriteByte(s[i+1])
				}
				i += 2
				continue
			}
			if c == '"' {
				closed = true
				i++
				break
			}
			b.WriteByte(c)
			i++
		}
		if !closed {
			return nil, 0, false
		}
		labels[key] = b.String()
	}
}
