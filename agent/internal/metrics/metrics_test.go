// SPDX-License-Identifier: AGPL-3.0-only

package metrics

import (
	"strings"
	"testing"
	"time"
)

func TestWriteTextIsSortedAndQuoted(t *testing.T) {
	ts := time.UnixMilli(1700000000000)
	samples := []Sample{
		New("watchlog_node_load1", 0.5),
		New("watchlog_node_cpu_seconds_total", 12.5, "mode", "user"),
		New("watchlog_node_filesystem_bytes", 1e9, "mount", `/mnt/"odd"`, "state", "size"),
	}
	var b strings.Builder
	if err := WriteText(&b, samples, ts); err != nil {
		t.Fatal(err)
	}
	want := `watchlog_node_cpu_seconds_total{mode="user"} 12.5 1700000000000
watchlog_node_filesystem_bytes{mount="/mnt/\"odd\"",state="size"} 1e+09 1700000000000
watchlog_node_load1 0.5 1700000000000
`
	if b.String() != want {
		t.Errorf("got:\n%s\nwant:\n%s", b.String(), want)
	}
}

func TestSeriesKeyIgnoresLabelOrder(t *testing.T) {
	a := New("m", 1, "a", "1", "b", "2")
	b := New("m", 2, "b", "2", "a", "1")
	if a.SeriesKey() != b.SeriesKey() {
		t.Error("series keys differ for the same labels in a different order")
	}
}

func TestNewPanicsOnOddLabels(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("expected panic")
		}
	}()
	New("m", 1, "lonely") //nolint:staticcheck // deliberately odd to test the panic
}
