// SPDX-License-Identifier: AGPL-3.0-only

package remotewrite

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/snappy"
	"google.golang.org/protobuf/encoding/protowire"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

var update = flag.Bool("update", false, "rewrite golden files")

type decodedSeries struct {
	Labels    map[string]string `json:"labels"`
	Value     float64           `json:"value"`
	Timestamp int64             `json:"timestamp"`
}

// decode is an independent reader for the three messages, used to check the encoder.
func decode(t *testing.T, b []byte) []decodedSeries {
	t.Helper()
	var out []decodedSeries
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 || num != 1 || typ != protowire.BytesType {
			t.Fatalf("WriteRequest: unexpected field %d/%d", num, typ)
		}
		b = b[n:]
		tsb, n := protowire.ConsumeBytes(b)
		b = b[n:]
		s := decodedSeries{Labels: map[string]string{}}
		for len(tsb) > 0 {
			num, _, n := protowire.ConsumeTag(tsb)
			tsb = tsb[n:]
			inner, n := protowire.ConsumeBytes(tsb)
			tsb = tsb[n:]
			switch num {
			case 1:
				var name, value string
				for len(inner) > 0 {
					f, _, n := protowire.ConsumeTag(inner)
					inner = inner[n:]
					v, n := protowire.ConsumeString(inner)
					inner = inner[n:]
					if f == 1 {
						name = v
					} else {
						value = v
					}
				}
				s.Labels[name] = value
			case 2:
				_, _, n := protowire.ConsumeTag(inner)
				bits, m := protowire.ConsumeFixed64(inner[n:])
				s.Value = math.Float64frombits(bits)
				_, _, k := protowire.ConsumeTag(inner[n+m:])
				ts, _ := protowire.ConsumeVarint(inner[n+m+k:])
				s.Timestamp = int64(ts)
			}
		}
		out = append(out, s)
	}
	return out
}

var goldenSamples = []metrics.Sample{
	metrics.New("watchlog_node_load1", 0.26, "host", "web-01"),
	metrics.New("watchlog_node_cpu_seconds_total", 18.8, "mode", "user", "host", "web-01"),
	metrics.New("watchlog_node_filesystem_bytes", 3.0083776512e10, "state", "size", "mount", "/", "host", "web-01"),
}

const goldenTimestamp = int64(1793404800000)

func TestRoundTrip(t *testing.T) {
	body := Encode(goldenSamples, goldenTimestamp)
	raw, err := snappy.Decode(nil, body)
	if err != nil {
		t.Fatal(err)
	}
	got := decode(t, raw)
	if len(got) != 3 {
		t.Fatalf("got %d series", len(got))
	}
	if got[1].Labels["__name__"] != "watchlog_node_cpu_seconds_total" || got[1].Labels["mode"] != "user" ||
		got[1].Value != 18.8 || got[1].Timestamp != goldenTimestamp {
		t.Errorf("series 1 = %+v", got[1])
	}
}

func TestLabelsAreSortedWithNameFirst(t *testing.T) {
	raw := Marshal([]metrics.Sample{metrics.New("m", 1, "z", "1", "a", "2")}, 0)
	// Labels appear in the byte stream in order: __name__, a, z.
	s := string(raw)
	if strings.Index(s, "__name__") >= strings.Index(s, "\x01a") || strings.Index(s, "\x01a") >= strings.Index(s, "\x01z") {
		t.Errorf("labels not in __name__, a, z order: %q", s)
	}
}

// The golden files are shared with the backend's decoder tests (ADR-021).
func TestGolden(t *testing.T) {
	body := Encode(goldenSamples, goldenTimestamp)
	raw, _ := snappy.Decode(nil, body)
	described, err := json.MarshalIndent(decode(t, raw), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.WriteFile("testdata/write-request.snappy", body, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile("testdata/write-request.json", append(described, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile("testdata/write-request.snappy")
	if err != nil {
		t.Fatalf("%v (run go test -update)", err)
	}
	if !bytes.Equal(body, want) {
		t.Error("encoded body differs from testdata/write-request.snappy; run go test -update if intended")
	}
}

// TestVictoriaMetricsAcceptsBody writes to a real VictoriaMetrics when
// WATCHLOG_TEST_VM_URL is set (e.g. http://127.0.0.1:8428) and reads the series back.
func TestVictoriaMetricsAcceptsBody(t *testing.T) {
	vm := os.Getenv("WATCHLOG_TEST_VM_URL")
	if vm == "" {
		t.Skip("WATCHLOG_TEST_VM_URL not set")
	}
	name := fmt.Sprintf("watchlog_test_roundtrip_%d", time.Now().UnixNano())
	ts := time.Now().Add(-time.Minute).UnixMilli()
	body := Encode([]metrics.Sample{metrics.New(name, 42.5, "host", "it")}, ts)
	req, _ := http.NewRequest(http.MethodPost, vm+"/api/v1/write", bytes.NewReader(body))
	req.Header.Set("Content-Type", ContentType)
	req.Header.Set("Content-Encoding", ContentEncoding)
	req.Header.Set("X-Prometheus-Remote-Write-Version", ProtocolVersion)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("write status %d", res.StatusCode)
	}
	t.Cleanup(func() {
		r, err := http.PostForm(vm+"/api/v1/admin/tsdb/delete_series", url.Values{"match[]": {name}})
		if err == nil {
			_ = r.Body.Close()
		}
	})

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_ = postNoBody(vm + "/internal/force_flush")
		r, err := http.Get(vm + "/api/v1/export?match[]=" + url.QueryEscape(name))
		if err == nil {
			b, _ := io.ReadAll(r.Body)
			_ = r.Body.Close()
			if strings.Contains(string(b), `"values":[42.5]`) && strings.Contains(string(b), `"host":"it"`) {
				return
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("series not readable from VictoriaMetrics")
}

func postNoBody(u string) error {
	r, err := http.Get(u)
	if err == nil {
		_ = r.Body.Close()
	}
	return err
}
