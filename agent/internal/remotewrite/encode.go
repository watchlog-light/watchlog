// SPDX-License-Identifier: AGPL-3.0-only

// Package remotewrite encodes Prometheus Remote-Write 1.0 requests (ADR-021):
//
//	message WriteRequest { repeated TimeSeries timeseries = 1; }
//	message TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2; }
//	message Label        { string name = 1; string value = 2; }
//	message Sample       { double value = 1; int64 timestamp = 2; }
//
// The body is block-format snappy, as the protocol requires.
package remotewrite

import (
	"math"
	"sort"

	"github.com/klauspost/compress/snappy"
	"google.golang.org/protobuf/encoding/protowire"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// ContentType and the other headers a remote_write request must carry.
const (
	ContentType     = "application/x-protobuf"
	ContentEncoding = "snappy"
	ProtocolVersion = "0.1.0"
)

// Marshal encodes samples as an uncompressed WriteRequest. Each sample becomes
// one TimeSeries with a single sample at timestampMs (or its own TimestampMs);
// labels are sorted with __name__ first.
func Marshal(samples []metrics.Sample, timestampMs int64) []byte {
	var out []byte
	var ts []byte
	for _, s := range samples {
		ts = ts[:0]
		labels := make([]metrics.Label, 0, len(s.Labels)+1)
		labels = append(labels, metrics.Label{Name: "__name__", Value: s.Name})
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
		at := timestampMs
		if s.TimestampMs != 0 { // a sample held back with its own time (ADR-049)
			at = s.TimestampMs
		}
		sb = protowire.AppendVarint(sb, uint64(at)) //nolint:gosec // protobuf int64 is encoded as its two's-complement uint64
		ts = protowire.AppendTag(ts, 2, protowire.BytesType)
		ts = protowire.AppendBytes(ts, sb)

		out = protowire.AppendTag(out, 1, protowire.BytesType)
		out = protowire.AppendBytes(out, ts)
	}
	return out
}

// Encode returns the snappy-compressed request body.
func Encode(samples []metrics.Sample, timestampMs int64) []byte {
	return snappy.Encode(nil, Marshal(samples, timestampMs))
}
