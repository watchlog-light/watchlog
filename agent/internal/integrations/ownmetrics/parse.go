// SPDX-License-Identifier: AGPL-3.0-only

// Package ownmetrics scrapes the endpoints that expose a user's own metrics (1.0.0, ADR-236):
// pods annotated `watchlog.io/scrape: "true"` and addresses added in the panel for one server.
// The backend hands the collector its targets; the collector fetches each one every 30
// seconds, reads the Prometheus text or OpenMetrics format, and posts what it read. Which
// series are stored, under which labels and within which caps is the backend's decision.
package ownmetrics

import (
	"bufio"
	"io"
	"math"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/integrations/promtext"
)

// Series is one sample of a scrape.
type Series struct {
	Name   string            `json:"n"`
	Labels map[string]string `json:"l,omitempty"`
	Value  float64           `json:"v"`
}

// Scrape is what one endpoint exposed.
type Scrape struct {
	// ContentType is the answer's Content-Type header (set by Fetch; a test says "HTML" from it).
	ContentType string
	Series      []Series
	// Types and Help by metric family, from the TYPE and HELP lines.
	Types map[string]string
	Help  map[string]string
	// Truncated says the endpoint had more series than MaxSeries; the rest were not read.
	Truncated bool
}

// Limits of one scrape.
const (
	// MaxBody bounds what is read of one answer (the brief's 5 MB).
	MaxBody = 5 << 20
	// MaxSeries bounds the series kept of one endpoint: well above what a plan lets one
	// source bring (500), so the backend can say how many it dropped.
	MaxSeries = 5000
	maxHelp   = 200
)

// knownTypes are the families the backend stores; the others (info, stateset, unknown,
// gaugehistogram) are sent without a type and read by their names.
var knownTypes = map[string]bool{"counter": true, "gauge": true, "histogram": true, "summary": true}

// Parse reads the Prometheus text format (0.0.4) or OpenMetrics (1.0) from r: the samples,
// the TYPE and HELP lines. A line that doesn't parse is skipped, never fatal; NaN and
// infinite values are dropped (a histogram's +Inf bucket is a label, not a value);
// OpenMetrics' `_created` series are left out (they are timestamps of the series, not data).
func Parse(r io.Reader) (Scrape, error) {
	out := Scrape{Types: map[string]string{}, Help: map[string]string{}}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), promtext.MaxLine)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		if line[0] == '#' {
			f := strings.SplitN(line, " ", 4)
			if len(f) >= 4 && f[1] == "TYPE" {
				if t := strings.TrimSpace(f[3]); knownTypes[t] {
					out.Types[f[2]] = t
				}
			} else if len(f) >= 4 && f[1] == "HELP" {
				h := f[3]
				if len(h) > maxHelp {
					h = h[:maxHelp]
				}
				out.Help[f[2]] = h
			}
			continue
		}
		s, ok := promtext.ParseSample(line)
		if !ok || math.IsNaN(s.Value) || math.IsInf(s.Value, 0) {
			continue
		}
		if strings.HasSuffix(s.Name, "_created") {
			if _, counter := out.Types[strings.TrimSuffix(s.Name, "_created")]; counter {
				continue
			}
		}
		if len(out.Series) >= MaxSeries {
			out.Truncated = true
			continue
		}
		out.Series = append(out.Series, Series{Name: s.Name, Labels: s.Labels, Value: s.Value})
	}
	if err := sc.Err(); err != nil && err != bufio.ErrTooLong {
		return out, err
	}
	// OpenMetrics names a counter's family without `_total`; the series carry it.
	for fam, t := range out.Types {
		if t == "counter" && !strings.HasSuffix(fam, "_total") {
			if _, has := out.Types[fam+"_total"]; !has && hasSeries(out.Series, fam+"_total") {
				out.Types[fam+"_total"] = t
				if h, ok := out.Help[fam]; ok {
					out.Help[fam+"_total"] = h
				}
			}
		}
	}
	return out, nil
}

func hasSeries(series []Series, name string) bool {
	for _, s := range series {
		if s.Name == name {
			return true
		}
	}
	return false
}
