// SPDX-License-Identifier: AGPL-3.0-only

// Package sender delivers buffered remote_write batches and heartbeats to the
// ingest API (SPEC §8.2) with the response handling of ADR-022.
package sender

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/remotewrite"
)

// Timing defaults (ADR-022).
const (
	UnauthorizedPause = 5 * time.Minute
	minBackoff        = time.Second
	maxBackoff        = 60 * time.Second
	ReplayInterval    = time.Second // at most 1 request/s while draining (ADR-027)
	idlePoll          = time.Second
)

// Config describes where and how to send.
type Config struct {
	WriteURL     string
	HeartbeatURL string
	ObjectsURL   string
	EventsURL    string
	Token        string
	AgentID      string // host name; the backend's per-agent rate-limit key
	UserAgent    string
	Client       *http.Client
}

// Outcome of one delivery attempt.
type Outcome int

const (
	Delivered Outcome = iota // 2xx: batch removed
	Retry                    // network error, 408, 429, 5xx: batch kept
	Paused                   // 401, 403, 404, 405: configuration problem; batch kept, pause
	Rejected                 // other 4xx: batch dropped
	Idle                     // nothing to send
)

// Stats are the sender's self-metrics.
type Stats struct {
	Requests           sync.Map // Outcome -> *atomic.Int64
	RejectedByCode     sync.Map // int status -> *atomic.Int64
	Failed             sync.Map // Failure -> *atomic.Int64, every endpoint
	LastDurationMicros atomic.Int64
}

// Failure is a failed ingest request: the endpoint (write, heartbeat, objects, events)
// and the HTTP status, 0 when the request got no response (network, timeout).
type Failure struct {
	Endpoint string
	Status   int
}

// Failures returns the failed requests so far by endpoint and status: what the agent
// saw, including failures the backend never recorded (unreachable, a proxy's 502).
func (s *Stats) Failures() map[Failure]int64 {
	out := map[Failure]int64{}
	s.Failed.Range(func(k, v any) bool { out[k.(Failure)] = v.(*atomic.Int64).Load(); return true })
	return out
}

func (s *Stats) inc(m *sync.Map, key any) {
	v, _ := m.LoadOrStore(key, new(atomic.Int64))
	v.(*atomic.Int64).Add(1)
}

// Snapshot returns counts per outcome and per rejected status code.
func (s *Stats) Snapshot() (map[Outcome]int64, map[int]int64) {
	byOutcome, byCode := map[Outcome]int64{}, map[int]int64{}
	s.Requests.Range(func(k, v any) bool { byOutcome[k.(Outcome)] = v.(*atomic.Int64).Load(); return true })
	s.RejectedByCode.Range(func(k, v any) bool { byCode[k.(int)] = v.(*atomic.Int64).Load(); return true })
	return byOutcome, byCode
}

// Sender drains a buffer to the ingest API.
type Sender struct {
	cfg   Config
	buf   *buffer.Buffer
	Stats Stats
	log   *slog.Logger

	// sleep waits for d or until ctx is done; replaced in tests.
	sleep   func(ctx context.Context, d time.Duration) error
	backoff time.Duration
}

// New returns a sender.
func New(cfg Config, buf *buffer.Buffer, log *slog.Logger) *Sender {
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 30 * time.Second}
	}
	return &Sender{cfg: cfg, buf: buf, log: log, sleep: sleepCtx}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Run sends batches until ctx is cancelled.
func (s *Sender) Run(ctx context.Context) {
	for ctx.Err() == nil {
		outcome, wait := s.SendOldest(ctx)
		if outcome == Delivered || outcome == Rejected {
			if files, _, _ := s.buf.Stats(); files > 0 {
				wait = ReplayInterval
			} else {
				wait = idlePoll
			}
		}
		if outcome == Idle {
			wait = idlePoll
		}
		_ = s.sleep(ctx, wait)
	}
}

// SendOldest makes one delivery attempt for the oldest batch and returns what
// happened and how long to wait before the next attempt.
func (s *Sender) SendOldest(ctx context.Context) (Outcome, time.Duration) {
	item, ok, err := s.buf.Oldest()
	if err != nil {
		s.log.Error("reading buffer", "err", err)
		return Retry, s.nextBackoff(0)
	}
	if !ok {
		return Idle, 0
	}
	body, err := s.buf.Read(item)
	if err != nil {
		s.log.Error("reading buffered batch", "batch", item.Name, "err", err)
		return Retry, s.nextBackoff(0)
	}

	start := time.Now()
	status, retryAfter, err := s.post(ctx, "write", s.cfg.WriteURL, body, map[string]string{
		"Content-Type":                      remotewrite.ContentType,
		"Content-Encoding":                  remotewrite.ContentEncoding,
		"X-Prometheus-Remote-Write-Version": remotewrite.ProtocolVersion,
	})
	s.Stats.LastDurationMicros.Store(time.Since(start).Microseconds())

	outcome := Classify(status, err)
	s.Stats.inc(&s.Stats.Requests, outcome)
	switch outcome {
	case Delivered:
		s.backoff = 0
		if err := s.buf.Remove(item); err != nil {
			s.log.Error("removing delivered batch", "batch", item.Name, "err", err)
		}
		return Delivered, 0
	case Rejected:
		s.backoff = 0
		s.Stats.inc(&s.Stats.RejectedByCode, status)
		s.log.Warn("ingest rejected a batch; dropping it", "status", status, "batch", item.Name, "bytes", item.Size)
		if err := s.buf.Remove(item); err != nil {
			s.log.Error("removing rejected batch", "batch", item.Name, "err", err)
		}
		return Rejected, 0
	case Paused:
		if status == http.StatusUnauthorized {
			s.log.Error("ingest rejected the token (401); check WATCHLOG_TOKEN. Retrying in 5 minutes, data stays buffered")
		} else {
			s.log.Error("ingest endpoint not usable; check WATCHLOG_ENDPOINT and the backend version. Retrying in 5 minutes, data stays buffered", "status", status)
		}
		return Paused, UnauthorizedPause
	default:
		if err != nil {
			s.log.Warn("ingest unreachable; data stays buffered", "err", err)
		} else {
			s.log.Warn("ingest temporarily unavailable; data stays buffered", "status", status)
		}
		return Retry, s.nextBackoff(retryAfter)
	}
}

// Classify maps a response to an outcome (ADR-022, ADR-042). 401/403/404/405 mean
// the agent is misconfigured (token or endpoint), not that the batch is bad, so
// the batch is kept; other 4xx are poison batches and are dropped.
func Classify(status int, err error) Outcome {
	switch {
	case err != nil:
		return Retry
	case status >= 200 && status < 300:
		return Delivered
	case status == http.StatusUnauthorized, status == http.StatusForbidden,
		status == http.StatusNotFound, status == http.StatusMethodNotAllowed:
		return Paused
	case status == http.StatusRequestTimeout, status == http.StatusTooManyRequests, status >= 500:
		return Retry
	case status >= 400:
		return Rejected
	default:
		return Retry // 1xx/3xx are unexpected; keep the batch
	}
}

// nextBackoff doubles the backoff (1 s → 60 s) with jitter, or honours Retry-After.
func (s *Sender) nextBackoff(retryAfter time.Duration) time.Duration {
	if s.backoff == 0 {
		s.backoff = minBackoff
	} else {
		s.backoff = min(2*s.backoff, maxBackoff)
	}
	if retryAfter > 0 {
		return min(retryAfter, UnauthorizedPause)
	}
	// Jitter in [backoff/2, backoff] spreads reconnecting agents.
	half := s.backoff / 2
	return half + time.Duration(rand.Int64N(int64(half)+1)) //nolint:gosec // jitter, not a secret
}

// Heartbeat is the body of POST /ingest/v1/heartbeat (SPEC §8.2).
type Heartbeat struct {
	AgentVersion string       `json:"agent_version"`
	Mode         string       `json:"mode"`
	Node         string       `json:"node"`
	Capabilities Capabilities `json:"capabilities"`
	Series       int          `json:"series"`
}

// Capabilities reported in the heartbeat.
type Capabilities struct {
	EBPF string `json:"ebpf"` // enabled | unsupported | disabled
	// EBPFReason says why eBPF is unsupported, or what part is missing when enabled.
	EBPFReason string `json:"ebpf_reason,omitempty"`
	// EBPFCause is the reason as a code when eBPF is not running:
	// config | kernel | permission | load.
	EBPFCause string `json:"ebpf_cause,omitempty"`
	Cgroup    string `json:"cgroup"` // v2 | v1 | unknown
	// KubeletTLS reports the node agent's kubelet connection (ADR-051).
	KubeletTLS string `json:"kubelet_tls,omitempty"` // verified | unverified
	// HelmRelease (namespace/release) and HelmChart are set by the agent chart so the UI
	// can show the exact upgrade command.
	HelmRelease string `json:"helm_release,omitempty"`
	HelmChart   string `json:"helm_chart,omitempty"`
	// ContainerID is the Docker agent's own container, named in its upgrade command.
	ContainerID string `json:"container_id,omitempty"`
	// NodeScope is where node metrics come from: host or cgroup (ADR-121).
	NodeScope string `json:"node_scope,omitempty"`
	// NodeCPUCores and NodeMemoryBytes are the node's capacity measured from its cgroup
	// in cgroup scope; the backend shows them instead of the Node object's, which are
	// the host's when nodes are containers on a shared kernel.
	NodeCPUCores    float64 `json:"node_cpu_cores,omitempty"`
	NodeMemoryBytes float64 `json:"node_memory_bytes,omitempty"`
}

// SendHeartbeat posts one heartbeat and returns its outcome.
func (s *Sender) SendHeartbeat(ctx context.Context, body []byte) Outcome {
	status, _, err := s.post(ctx, "heartbeat", s.cfg.HeartbeatURL, body, map[string]string{"Content-Type": "application/json"})
	outcome := Classify(status, err)
	if outcome != Delivered {
		s.log.Debug("heartbeat not delivered", "status", status, "err", err)
	}
	return outcome
}

// PostJSON posts a small JSON body to url (integrations probe results) and returns the
// outcome; endpoint names it in the failure counts (ADR-117).
func (s *Sender) PostJSON(ctx context.Context, endpoint, url string, body []byte) Outcome {
	status, _, err := s.post(ctx, endpoint, url, body, map[string]string{"Content-Type": "application/json"})
	return Classify(status, err)
}

// SendObjects posts an inventory snapshot as gzipped JSON (SPEC §8.2) and
// returns the outcome and HTTP status (0 on network errors).
func (s *Sender) SendObjects(ctx context.Context, body []byte) (Outcome, int) {
	return s.sendJSON(ctx, "objects", s.cfg.ObjectsURL, body)
}

// SendEvents posts a batch of Kubernetes events as gzipped JSON (SPEC §8.2).
func (s *Sender) SendEvents(ctx context.Context, body []byte) (Outcome, int) {
	return s.sendJSON(ctx, "events", s.cfg.EventsURL, body)
}

func (s *Sender) sendJSON(ctx context.Context, endpoint, url string, body []byte) (Outcome, int) {
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	if _, err := w.Write(body); err != nil {
		return Retry, 0
	}
	if err := w.Close(); err != nil {
		return Retry, 0
	}
	status, _, err := s.post(ctx, endpoint, url, gz.Bytes(),
		map[string]string{"Content-Type": "application/json", "Content-Encoding": "gzip"})
	return Classify(status, err), status
}

// post sends one request; every response other than 2xx, and every request without a
// response, counts as a failure of its endpoint (ADR-117).
func (s *Sender) post(ctx context.Context, endpoint, url string, body []byte, headers map[string]string) (int, time.Duration, error) {
	status, retryAfter, err := s.do(ctx, url, body, headers)
	if err != nil || status < 200 || status > 299 {
		if err != nil {
			status = 0
		}
		s.Stats.inc(&s.Stats.Failed, Failure{Endpoint: endpoint, Status: status})
	}
	return status, retryAfter, err
}

func (s *Sender) do(ctx context.Context, url string, body []byte, headers map[string]string) (int, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.Token)
	req.Header.Set("User-Agent", s.cfg.UserAgent)
	req.Header.Set("X-WatchLog-Agent", s.cfg.AgentID)
	res, err := s.cfg.Client.Do(req)
	if err != nil {
		return 0, 0, redactErr(err, s.cfg.Token)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	return res.StatusCode, parseRetryAfter(res.Header.Get("Retry-After"), time.Now()), nil
}

// parseRetryAfter accepts delta-seconds or an HTTP date.
func parseRetryAfter(v string, now time.Time) time.Duration {
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

// redactErr makes sure the token never reaches a log line through a URL or error text.
func redactErr(err error, token string) error {
	if token == "" || !bytes.Contains([]byte(err.Error()), []byte(token)) {
		return err
	}
	return errors.New(string(bytes.ReplaceAll([]byte(err.Error()), []byte(token), []byte("<redacted>"))))
}

// String names an outcome for metrics and logs.
func (o Outcome) String() string {
	switch o {
	case Delivered:
		return "delivered"
	case Retry:
		return "retry"
	case Paused:
		return "paused"
	case Rejected:
		return "rejected"
	case Idle:
		return "idle"
	}
	return fmt.Sprintf("outcome(%d)", int(o))
}
