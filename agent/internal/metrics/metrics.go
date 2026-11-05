// SPDX-License-Identifier: AGPL-3.0-only

// Package metrics holds the agent's sample model and text exposition.
package metrics

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Label is one name/value pair of a series.
type Label struct {
	Name  string
	Value string
}

// Sample is one value of one series at scrape time.
type Sample struct {
	Name   string
	Labels []Label
	Value  float64
	// TimestampMs, when set, overrides the batch time (samples held back for labels).
	TimestampMs int64
}

// New builds a sample from alternating label name/value pairs.
func New(name string, value float64, labelPairs ...string) Sample {
	if len(labelPairs)%2 != 0 {
		panic("metrics.New: odd number of label arguments")
	}
	labels := make([]Label, 0, len(labelPairs)/2)
	for i := 0; i+1 < len(labelPairs); i += 2 {
		labels = append(labels, Label{Name: labelPairs[i], Value: labelPairs[i+1]})
	}
	return Sample{Name: name, Labels: labels, Value: value}
}

// WithLabels returns a copy of the sample with extra labels appended.
func (s Sample) WithLabels(extra ...Label) Sample {
	labels := make([]Label, 0, len(s.Labels)+len(extra))
	labels = append(labels, s.Labels...)
	labels = append(labels, extra...)
	return Sample{Name: s.Name, Labels: labels, Value: s.Value, TimestampMs: s.TimestampMs}
}

// SeriesKey identifies the series (name + sorted labels).
func (s Sample) SeriesKey() string {
	labels := append([]Label(nil), s.Labels...)
	sort.Slice(labels, func(i, j int) bool { return labels[i].Name < labels[j].Name })
	var b strings.Builder
	b.WriteString(s.Name)
	for _, l := range labels {
		b.WriteByte(0)
		b.WriteString(l.Name)
		b.WriteByte(0)
		b.WriteString(l.Value)
	}
	return b.String()
}

// WriteText writes samples in Prometheus text format, sorted for stable output.
func WriteText(w io.Writer, samples []Sample, ts time.Time) error {
	sorted := append([]Sample(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].SeriesKey() < sorted[j].SeriesKey() })
	for _, s := range sorted {
		var b strings.Builder
		b.WriteString(s.Name)
		if len(s.Labels) > 0 {
			b.WriteByte('{')
			for i, l := range s.Labels {
				if i > 0 {
					b.WriteByte(',')
				}
				fmt.Fprintf(&b, "%s=%q", l.Name, l.Value)
			}
			b.WriteByte('}')
		}
		fmt.Fprintf(&b, " %s %d\n", formatValue(s.Value), ts.UnixMilli())
		if _, err := io.WriteString(w, b.String()); err != nil {
			return err
		}
	}
	return nil
}

func formatValue(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}
