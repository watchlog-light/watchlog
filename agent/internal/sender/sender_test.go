// SPDX-License-Identifier: AGPL-3.0-only

package sender

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
)

const token = "wl_ct_secret-token-value"

type recorded struct {
	body    string
	headers http.Header
}

func setup(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*Sender, *buffer.Buffer, *[]recorded) {
	t.Helper()
	var mu sync.Mutex
	var reqs []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, recorded{body: string(b), headers: r.Header.Clone()})
		mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	buf, err := buffer.Open(t.TempDir(), 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	s := New(Config{WriteURL: srv.URL + "/ingest/v1/write", HeartbeatURL: srv.URL + "/ingest/v1/heartbeat",
		Token: token, AgentID: "web-01", UserAgent: "watchlog-agent/test"}, buf, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return s, buf, &reqs
}

func status(code int) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }
}

func put(t *testing.T, buf *buffer.Buffer, bodies ...string) {
	t.Helper()
	for _, b := range bodies {
		if _, err := buf.Put([]byte(b)); err != nil {
			t.Fatal(err)
		}
	}
}

func files(t *testing.T, buf *buffer.Buffer) int {
	n, _, err := buf.Stats()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeliveredBatchIsRemovedAndHeadersAreSet(t *testing.T) {
	s, buf, reqs := setup(t, status(http.StatusNoContent))
	put(t, buf, "batch-1")
	outcome, _ := s.SendOldest(context.Background())
	if outcome != Delivered || files(t, buf) != 0 {
		t.Fatalf("outcome %v, %d files left", outcome, files(t, buf))
	}
	h := (*reqs)[0].headers
	for k, want := range map[string]string{
		"Authorization": "Bearer " + token, "Content-Encoding": "snappy", "Content-Type": "application/x-protobuf",
		"X-Prometheus-Remote-Write-Version": "0.1.0", "X-Watchlog-Agent": "web-01", "User-Agent": "watchlog-agent/test",
	} {
		if got := h.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if (*reqs)[0].body != "batch-1" {
		t.Errorf("body = %q", (*reqs)[0].body)
	}
}

// Permanent 4xx: drop, count, never block the queue (ADR-022).
func TestPermanentClientErrorsDropTheBatch(t *testing.T) {
	for _, code := range []int{400, 402, 409, 413, 415, 422} {
		s, buf, _ := setup(t, status(code))
		put(t, buf, "poison", "next")
		outcome, wait := s.SendOldest(context.Background())
		if outcome != Rejected || wait != 0 {
			t.Errorf("%d: outcome %v, wait %v", code, outcome, wait)
		}
		if n := files(t, buf); n != 1 {
			t.Errorf("%d: %d files left, want only the next batch", code, n)
		}
		_, byCode := s.Stats.Snapshot()
		if byCode[code] != 1 {
			t.Errorf("%d: rejected counter = %d", code, byCode[code])
		}
	}
}

// 401 and endpoint/configuration errors keep buffering and pause (ADR-022, ADR-042).
func TestConfigurationErrorsKeepBufferingAndPauseFiveMinutes(t *testing.T) {
	for _, code := range []int{401, 403, 404, 405} {
		s, buf, _ := setup(t, status(code))
		put(t, buf, "batch")
		outcome, wait := s.SendOldest(context.Background())
		if outcome != Paused || wait != 5*time.Minute || files(t, buf) != 1 {
			t.Errorf("%d: outcome %v, wait %v, files %d", code, outcome, wait, files(t, buf))
		}
	}
}

func TestRetryableResponsesKeepTheBatch(t *testing.T) {
	for _, code := range []int{408, 429, 500, 502, 503} {
		s, buf, _ := setup(t, status(code))
		put(t, buf, "batch")
		outcome, wait := s.SendOldest(context.Background())
		if outcome != Retry || files(t, buf) != 1 || wait < 500*time.Millisecond || wait > time.Second {
			t.Errorf("%d: outcome %v, wait %v, files %d", code, outcome, wait, files(t, buf))
		}
	}
}

func TestRetryAfterIsHonoured(t *testing.T) {
	s, buf, _ := setup(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	put(t, buf, "batch")
	if _, wait := s.SendOldest(context.Background()); wait != 7*time.Second {
		t.Errorf("wait = %v, want 7s", wait)
	}
}

func TestNetworkErrorsRetryWithGrowingBackoffAndRedactTheToken(t *testing.T) {
	s, buf, _ := setup(t, status(204))
	s.cfg.WriteURL = "http://127.0.0.1:1/ingest/v1/write?token=" + token // nothing listens on port 1
	var logs strings.Builder
	s.log = slog.New(slog.NewTextHandler(&logs, nil))
	put(t, buf, "batch")
	var waits []time.Duration
	for i := 0; i < 8; i++ {
		outcome, wait := s.SendOldest(context.Background())
		if outcome != Retry {
			t.Fatalf("attempt %d: outcome %v", i, outcome)
		}
		waits = append(waits, wait)
	}
	if waits[0] > time.Second || waits[7] < 30*time.Second || waits[7] > 60*time.Second {
		t.Errorf("backoff progression %v", waits)
	}
	if files(t, buf) != 1 {
		t.Error("batch must stay buffered on network errors")
	}
	if strings.Contains(logs.String(), token) {
		t.Error("token leaked into logs")
	}
}

func TestRunReplaysOldestFirstAtOneRequestPerSecond(t *testing.T) {
	s, buf, reqs := setup(t, status(http.StatusNoContent))
	put(t, buf, "1", "2", "3")
	ctx, cancel := context.WithCancel(context.Background())
	var sleeps []time.Duration
	s.sleep = func(_ context.Context, d time.Duration) error {
		sleeps = append(sleeps, d)
		if len(sleeps) == 3 {
			cancel()
		}
		return nil
	}
	s.Run(ctx)
	var order []string
	for _, r := range *reqs {
		order = append(order, r.body)
	}
	if strings.Join(order, ",") != "1,2,3" {
		t.Errorf("order = %v", order)
	}
	if sleeps[0] != ReplayInterval || sleeps[1] != ReplayInterval || sleeps[2] != idlePoll {
		t.Errorf("sleeps = %v", sleeps)
	}
}

func TestRecoversAfterOutage(t *testing.T) {
	var mu sync.Mutex
	down := true
	s, buf, _ := setup(t, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if down {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	put(t, buf, "a", "b")
	for i := 0; i < 3; i++ {
		if o, _ := s.SendOldest(context.Background()); o != Retry {
			t.Fatalf("expected retry while down, got %v", o)
		}
	}
	mu.Lock()
	down = false
	mu.Unlock()
	for i := 0; i < 2; i++ {
		if o, _ := s.SendOldest(context.Background()); o != Delivered {
			t.Fatalf("expected delivery after recovery, got %v", o)
		}
	}
	if files(t, buf) != 0 || s.backoff != 0 {
		t.Errorf("files %d, backoff %v", files(t, buf), s.backoff)
	}
}

func TestHeartbeat(t *testing.T) {
	s, _, reqs := setup(t, status(http.StatusNoContent))
	if o := s.SendHeartbeat(context.Background(), []byte(`{"node":"web-01"}`)); o != Delivered {
		t.Fatalf("heartbeat outcome %v", o)
	}
	if (*reqs)[0].headers.Get("Content-Type") != "application/json" || (*reqs)[0].headers.Get("Authorization") == "" {
		t.Errorf("heartbeat headers %v", (*reqs)[0].headers)
	}
}

func TestClassifyAndRetryAfterParsing(t *testing.T) {
	if Classify(0, errors.New("x")) != Retry || Classify(204, nil) != Delivered || Classify(301, nil) != Retry {
		t.Error("classification")
	}
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	if got := parseRetryAfter("Sat, 31 Oct 2026 12:00:30 GMT", now); got != 30*time.Second {
		t.Errorf("HTTP-date Retry-After = %v", got)
	}
	if parseRetryAfter("soon", now) != 0 || parseRetryAfter("-5", now) != 0 {
		t.Error("invalid Retry-After should be ignored")
	}
}

// Every failed request counts by endpoint and status (ADR-117): a backend that answers
// 500 to objects only, or is unreachable, shows in the agent's own metrics.
func TestFailedRequestsAreCountedByEndpointAndStatus(t *testing.T) {
	var code atomic.Int32
	code.Store(500)
	s, buf, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(int(code.Load())) })
	s.cfg.ObjectsURL = strings.Replace(s.cfg.WriteURL, "/write", "/objects", 1)
	ctx := context.Background()
	put(t, buf, "batch")
	s.SendOldest(ctx)
	s.SendObjects(ctx, []byte(`{}`))
	s.SendObjects(ctx, []byte(`{}`))
	code.Store(204)
	s.SendHeartbeat(ctx, []byte(`{}`))
	s.SendObjects(ctx, []byte(`{}`))
	// No response at all.
	s.cfg.EventsURL = "http://127.0.0.1:1/ingest/v1/events"
	s.SendEvents(ctx, []byte(`{}`))

	want := map[Failure]int64{
		{Endpoint: "write", Status: 500}:   1,
		{Endpoint: "objects", Status: 500}: 2,
		{Endpoint: "events", Status: 0}:    1,
	}
	if got := s.Stats.Failures(); !reflect.DeepEqual(got, want) {
		t.Errorf("failures = %v, want %v", got, want)
	}
}
