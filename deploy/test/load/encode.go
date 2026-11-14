// SPDX-License-Identifier: AGPL-3.0-only

package main

// The agent's remote_write encoder (agent/internal/remotewrite, ADR-021), copied: Go's
// internal packages can't be imported from outside the agent module. encode_test.go
// checks the copy against the agent's golden file byte for byte.

import (
	"math"
	"sort"

	"github.com/klauspost/compress/snappy"
	"google.golang.org/protobuf/encoding/protowire"
)

// Label and Sample are the agent's metrics.Label and metrics.Sample.
type Label struct {
	Name  string
	Value string
}

type Sample struct {
	Name   string
	Labels []Label
	Value  float64
}

// Marshal is remotewrite.Marshal: one TimeSeries per sample, labels sorted with
// __name__ first, one sample at timestampMs.
func Marshal(samples []Sample, timestampMs int64) []byte {
	var out []byte
	var ts []byte
	for _, s := range samples {
		ts = ts[:0]
		labels := make([]Label, 0, len(s.Labels)+1)
		labels = append(labels, Label{Name: "__name__", Value: s.Name})
		labels = append(labels, s.Labels...)
		sort.SliceStable(labels[1:], func(i, j int) bool { return labels[1+i].Name < labels[1+j].Name })
		for _, l := range labels {
			var lb []byte
			lb = protowire.AppendTag(lb, 1, protowire.BytesType)
			lb = protowire.AppendString(lb, l.Name)
			lb = protowire.AppendTag(lb, 2, protowire.BytesType)
			lb = protowire.AppendString(lb, l.Value)
			ts = protowire.AppendTag(ts, 1, protowire.BytesType)
			ts = protowire.AppendBytes(ts, lb)
		}
		var sb []byte
		sb = protowire.AppendTag(sb, 1, protowire.Fixed64Type)
		sb = protowire.AppendFixed64(sb, math.Float64bits(s.Value))
		sb = protowire.AppendTag(sb, 2, protowire.VarintType)
		sb = protowire.AppendVarint(sb, uint64(timestampMs)) //nolint:gosec // protobuf int64 is its two's-complement uint64
		ts = protowire.AppendTag(ts, 2, protowire.BytesType)
		ts = protowire.AppendBytes(ts, sb)

		out = protowire.AppendTag(out, 1, protowire.BytesType)
		out = protowire.AppendBytes(out, ts)
	}
	return out
}

// Encode is remotewrite.Encode: the block-format snappy body the agent sends.
func Encode(samples []Sample, timestampMs int64) []byte {
	return snappy.Encode(nil, Marshal(samples, timestampMs))
}
