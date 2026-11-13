// SPDX-License-Identifier: AGPL-3.0-only

// Package traefik is the Traefik integration (SPEC §4.12, ADR-165): Traefik's own
// Prometheus metrics, read with promtext, for v2.10+ and v3. What it reads:
//   - the metrics endpoint, looked for on 9100 (the Helm chart's and k3s's `metrics`
//     entrypoint), 8080 (the default `traefik` entrypoint) and 8082 at /metrics; when
//     none answers with traefik_ series, again every 10 minutes (every minute while the
//     member is new), and the status says what each place answered, so the page can give
//     the setting (`metrics_off`);
//   - /api/version on 8080, only when the API is open (api.insecure), for the version.
//
// Series keep fewer labels than Traefik exports: method, protocol and the TLS cipher and
// version are summed away; Traefik's `service` label becomes `traefik_service` (the
// collector's own `service` is the integration); Traefik's internal services
// (api@internal, prometheus@internal…) are dropped. v2's
// traefik_entrypoint_open_connections is written as v3's traefik_open_connections.
// Paths and hosts are never read (ADR-139): Traefik's metrics have none, and
// certificates keep only their common name.
package traefik

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/promtext"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const (
	// Recheck is how long a missing metrics endpoint is remembered; EarlyRecheck while
	// the member is new (someone may be turning metrics on right now).
	Recheck      = 10 * time.Minute
	EarlyRecheck = time.Minute
	// MaxSeries caps what one member adds (ADR-136).
	MaxSeries = 4000
	// MaxBody bounds one response read.
	MaxBody = 8 << 20
	// APIPort is the default `traefik` entrypoint, where /api/version answers when the
	// API is open.
	APIPort = "8080"
)

// MetricsPorts are tried in order: the Helm chart's and k3s's metrics entrypoint, the
// default traefik entrypoint, and the port the Docker docs use for a metrics entrypoint.
var MetricsPorts = []string{"9100", "8080", "8082"}

// kept are the families read and the labels each keeps; everything else is summed away.
var kept = map[string][]string{
	"traefik_entrypoint_requests_total":                  {"entrypoint", "code"},
	"traefik_entrypoint_request_duration_seconds_bucket": {"entrypoint", "le"},
	"traefik_entrypoint_request_duration_seconds_sum":    {"entrypoint"},
	"traefik_entrypoint_request_duration_seconds_count":  {"entrypoint"},
	"traefik_entrypoint_requests_tls_total":              {"entrypoint"},
	"traefik_service_requests_total":                     {"service", "code"},
	"traefik_service_request_duration_seconds_bucket":    {"service", "le"},
	"traefik_service_request_duration_seconds_sum":       {"service"},
	"traefik_service_request_duration_seconds_count":     {"service"},
	"traefik_service_retries_total":                      {"service"},
	"traefik_service_server_up":                          {"service", "url"},
	"traefik_service_requests_tls_total":                 {"service"},
	"traefik_router_requests_total":                      {"router", "service", "code"},
	"traefik_open_connections":                           {"entrypoint"},
	"traefik_entrypoint_open_connections":                {"entrypoint"},
	"traefik_tls_certs_not_after":                        {"cn"},
	"traefik_config_reloads_total":                       {},
	"traefik_config_last_reload_success":                 {},
	"traefik_config_reloads_failure_total":               {},
	"traefik_config_last_reload_failure":                 {},
}

// renamedFamily: v2's name for open connections becomes v3's.
var renamedFamily = map[string]string{"traefik_entrypoint_open_connections": "traefik_open_connections"}

// renamedLabel: Traefik's service would collide with the collector's own label.
var renamedLabel = map[string]string{"service": "traefik_service"}

// Traefik is the integration; it remembers per member where its metrics are.
type Traefik struct {
	mu      sync.Mutex
	members map[string]memberState
	Client  *http.Client
	Now     func() time.Time
	// Ports and APIPort are replaced in tests.
	Ports   []string
	APIPort string
}

type memberState struct {
	metricsURL string // found; empty when missing
	tried      bool
	triedAt    time.Time
	why        string
	firstSeen  time.Time
}

// New returns the integration.
func New() *Traefik {
	return &Traefik{
		members: map[string]memberState{},
		Client: &http.Client{
			Timeout:       integrations.DialTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		Now:     time.Now,
		Ports:   MetricsPorts,
		APIPort: APIPort,
	}
}

// Scrape implements integrations.Integration.
func (t *Traefik) Scrape(ctx context.Context, tg integrations.Target, _ bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK, Product: "traefik"}
	up := 0
	row := map[string]any{"metrics": false, "metrics_at": "", "tried": "", "routers": false, "health_checks": false, "major": ""}
	for _, m := range tg.Members {
		out := t.member(ctx, m)
		res.Members = append(res.Members, out.status)
		if !out.status.Up {
			continue
		}
		up++
		res.Samples = append(res.Samples, out.samples...)
		if out.metricsAt != "" {
			if row["metrics"] == false {
				row["metrics_at"] = out.metricsAt
			}
			row["metrics"] = true
		} else if row["tried"] == "" {
			row["tried"] = out.why
		}
		if out.routers {
			row["routers"] = true
		}
		if out.healthChecks {
			row["health_checks"] = true
		}
		if row["major"] == "" {
			row["major"] = out.major
		}
		if res.ServiceVersion == "" {
			res.ServiceVersion = out.version
		}
	}
	if row["metrics"] == true {
		row["tried"] = ""
	}
	res.Extra = map[string]any{"traefik": []map[string]any{row}}
	res.Facts = map[string]any{}
	for k, v := range row {
		res.Facts[k] = v
	}
	switch {
	case len(tg.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State, res.Error = integrations.StateError, res.Members[0].Error
	}
	return res
}

// Probe implements integrations.Prober: Traefik needs no user; the test is that a member
// answers, and it says whether its metrics were found.
func (t *Traefik) Probe(ctx context.Context, tg integrations.Target) integrations.ProbeResult {
	r := t.Scrape(ctx, tg, false)
	out := integrations.ProbeResult{Code: integrations.ProbeOK, Version: r.ServiceVersion, Facts: r.Facts}
	if r.State != integrations.StateOK {
		out.Code, out.Error = integrations.ProbeUnreachable, r.Error
	}
	return out
}

type memberOut struct {
	status       integrations.MemberStatus
	samples      []metrics.Sample
	metricsAt    string
	why          string
	version      string
	routers      bool
	healthChecks bool
	major        string
}

func (t *Traefik) member(ctx context.Context, m integrations.Member) memberOut {
	out := memberOut{status: integrations.MemberStatus{Name: m.Name}}
	host, _, err := net.SplitHostPort(m.Address)
	if err != nil {
		out.status.Error = "bad address " + m.Address
		return out
	}
	// Reachable at all: the service's own port accepts a connection (no request sent).
	start := time.Now()
	d := net.Dialer{Timeout: integrations.DialTimeout}
	conn, err := d.DialContext(ctx, "tcp", m.Address)
	if err != nil {
		out.status.Error = shortError(err)
		return out
	}
	_ = conn.Close()
	out.status.Up = true
	out.samples = append(out.samples, metrics.New("watchlog_integration_connect_seconds", time.Since(start).Seconds(), "member", m.Name))

	// By name and address: a recreated container can get another's old address.
	key := m.Name + "\x00" + m.Address
	st := t.state(key)
	now := t.Now()
	if st.firstSeen.IsZero() {
		st.firstSeen = now
	}
	wait := Recheck
	if now.Sub(st.firstSeen) < Recheck {
		wait = EarlyRecheck
	}
	if st.metricsURL == "" && (!st.tried || now.Sub(st.triedAt) > wait) {
		st.metricsURL, st.why = t.find(ctx, host)
		st.tried, st.triedAt = true, now
	}
	if st.metricsURL != "" {
		r, err := t.read(ctx, st.metricsURL)
		if err != nil {
			// Gone (config changed): look again next time.
			st.why = pathOf(st.metricsURL) + ": " + err.Error()
			st.metricsURL, st.tried = "", false
		} else {
			for _, s := range r.samples {
				out.samples = append(out.samples, s.WithLabels(metrics.Label{Name: "member", Value: m.Name}))
			}
			out.metricsAt = pathOf(st.metricsURL)
			out.routers, out.healthChecks, out.major = r.routers, r.healthChecks, r.major
			out.version = t.version(ctx, host)
		}
	}
	if out.metricsAt == "" {
		out.why = st.why
	}
	t.save(key, st)
	return out
}

func (t *Traefik) state(k string) memberState {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.members[k]
}

func (t *Traefik) save(k string, st memberState) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.members[k] = st
}

func (t *Traefik) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "watchlog-integrations")
	return t.Client.Do(req)
}

// find tries each port's /metrics; why says what each answered when none was Traefik's
// (":9100/metrics: connection refused; :8080/metrics: 404").
func (t *Traefik) find(ctx context.Context, host string) (url, why string) {
	var tried []string
	for _, p := range t.Ports {
		u := "http://" + net.JoinHostPort(host, p) + "/metrics"
		_, err := t.read(ctx, u)
		if err == nil {
			return u, ""
		}
		tried = append(tried, ":"+p+"/metrics: "+err.Error())
		if ctx.Err() != nil {
			break
		}
	}
	return "", strings.Join(tried, "; ")
}

type statusError int

func (e statusError) Error() string { return strconv.Itoa(int(e)) }

var errNotTraefik = errors.New("no traefik_ series")

// Parsed is one /metrics body as kept: the series, and what they say about the setup.
type Parsed struct {
	samples      []metrics.Sample
	routers      bool
	healthChecks bool
	major        string
}

func (t *Traefik) read(ctx context.Context, url string) (Parsed, error) {
	res, err := t.get(ctx, url)
	if err != nil {
		return Parsed{}, errors.New(shortError(err))
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return Parsed{}, statusError(res.StatusCode)
	}
	r, found := Parse(io.LimitReader(res.Body, MaxBody))
	if !found {
		return Parsed{}, errNotTraefik
	}
	return r, nil
}

// Parse reads one /metrics body into the kept series; found says whether it had any
// traefik_ series at all (an endpoint with metrics on but no traffic yet still counts).
func Parse(r io.Reader) (out Parsed, found bool) {
	parsed, _ := promtext.Parse(r, func(name string) bool {
		if strings.HasPrefix(name, "traefik_") {
			found = true
		}
		_, ok := kept[name]
		return ok
	})
	type key struct {
		name   string
		labels string
	}
	sums := map[key]float64{}
	var order []key
	labelsOf := map[key][]string{}
	for _, p := range parsed {
		if svc := p.Labels["service"]; strings.HasSuffix(svc, "@internal") {
			continue
		}
		switch p.Name {
		case "traefik_router_requests_total":
			out.routers = true
		case "traefik_service_server_up":
			out.healthChecks = true
		case "traefik_entrypoint_open_connections", "traefik_config_reloads_failure_total":
			out.major = "2"
		case "traefik_open_connections":
			if out.major == "" {
				out.major = "3"
			}
		}
		name := p.Name
		if r, ok := renamedFamily[name]; ok {
			name = r
		}
		var l []string
		for _, k := range kept[p.Name] {
			if v := p.Labels[k]; v != "" {
				n := k
				if r, ok := renamedLabel[k]; ok {
					n = r
				}
				l = append(l, n, v)
			}
		}
		k := key{name, strings.Join(l, "\x00")}
		if _, seen := sums[k]; !seen {
			if len(order) >= MaxSeries {
				continue
			}
			order = append(order, k)
			labelsOf[k] = l
		}
		sums[k] += p.Value
	}
	for _, k := range order {
		out.samples = append(out.samples, metrics.New(k.name, sums[k], labelsOf[k]...))
	}
	return out, found
}

// version reads /api/version, which answers only when the API is open (api.insecure).
func (t *Traefik) version(ctx context.Context, host string) string {
	res, err := t.get(ctx, "http://"+net.JoinHostPort(host, t.APIPort)+"/api/version")
	if err != nil {
		return ""
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	var v struct {
		Version string `json:"Version"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&v) != nil {
		return ""
	}
	return strings.TrimPrefix(v.Version, "v")
}

// pathOf turns "http://10.0.0.1:9100/metrics" into ":9100/metrics".
func pathOf(url string) string {
	rest := strings.TrimPrefix(url, "http://")
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		if _, p, err := net.SplitHostPort(rest[:i]); err == nil {
			return ":" + p + rest[i:]
		}
	}
	return url
}

func shortError(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && (strings.HasPrefix(msg, "dial ") || strings.HasPrefix(msg, "Get ")) {
		msg = msg[i+2:]
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}
