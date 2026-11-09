// SPDX-License-Identifier: AGPL-3.0-only

// Package nginx is the Nginx integration (SPEC §4.12, v0.3 slice 10). Requests, errors
// and latency come from elsewhere for plain Nginx: the node agents' eBPF HTTP stats
// (ADR-139), which need nothing from the user. What this reads:
//   - ingress-nginx: the controller's own metrics on :10254, as they are, with the
//     labels that identify an Ingress and its backend Service only (no path, host or
//     method). The controller serves them only with --enable-metrics (the chart's
//     controller.metrics.enabled), so a controller without them is reported as such.
//   - plain Nginx: stub_status, when someone added the location block, for the
//     Connections tab. It is looked for on the service's port and on 8080, at
//     /stub_status and /nginx_status; when missing, again every 10 minutes.
//
// Nothing else is requested from Nginx: no page on its main port, so its own traffic
// and logs see at most those few stub_status reads.
package nginx

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/promtext"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const (
	// MetricsPort is ingress-nginx's health and metrics port.
	MetricsPort = "10254"
	// StubPort is where the documented snippet serves stub_status, apart from traffic.
	StubPort = "8080"
	// Recheck is how long a missing stub_status or a member's kind is remembered;
	// EarlyRecheck while the member is new (its address may still be settling, or
	// someone is adding stub_status right now).
	Recheck      = 10 * time.Minute
	EarlyRecheck = time.Minute
	// MaxSeries caps what one member's ingress metrics add (ADR-136).
	MaxSeries = 4000
	// MaxBody bounds one response read.
	MaxBody = 8 << 20
)

// StubPaths are tried in order on each candidate port.
var StubPaths = []string{"/stub_status", "/nginx_status"}

// Nginx is the integration; it remembers per member what kind it is and where its
// stub_status is.
type Nginx struct {
	mu      sync.Mutex
	members map[string]memberState // by member name and address
	Client  *http.Client
	Now     func() time.Time
	// MetricsPort and StubPort are replaced in tests.
	MetricsPort, StubPort string
}

type memberState struct {
	ingress   bool
	kindAt    time.Time
	stubURL   string // found; empty when missing
	stubAt    time.Time
	stubTried bool
	firstSeen time.Time
	// stubWhy says what each place answered when none was stub_status.
	stubWhy string
}

// New returns the integration.
func New() *Nginx {
	return &Nginx{
		members: map[string]memberState{},
		Client: &http.Client{
			Timeout: integrations.DialTimeout,
			// stub_status and /metrics are never redirects; a redirect is not them.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		Now:         time.Now,
		MetricsPort: MetricsPort,
		StubPort:    StubPort,
	}
}

// Scrape implements integrations.Integration.
func (n *Nginx) Scrape(ctx context.Context, t integrations.Target, _ bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	up := 0
	ingress, metricsOn, stubFound, stubWhy := false, false, "", ""
	stubMissing := 0
	for _, m := range t.Members {
		out := n.member(ctx, m)
		res.Members = append(res.Members, out.status)
		if !out.status.Up {
			continue
		}
		up++
		res.Samples = append(res.Samples, out.samples...)
		if out.ingress {
			ingress = true
			metricsOn = metricsOn || out.metrics
		} else if out.stubPath != "" {
			stubFound = out.stubPath
		} else {
			stubMissing++
			if stubWhy == "" {
				stubWhy = out.stubWhy
			}
		}
		if res.ServiceVersion == "" {
			res.ServiceVersion = out.version
		}
	}
	extra := map[string]any{"flavour": "plain"}
	if ingress {
		res.Product = "ingress-nginx"
		extra = map[string]any{"flavour": "ingress", "metrics": metricsOn}
	} else if up > 0 {
		extra["stub_status"] = stubFound
		extra["stub_missing"] = stubMissing
		if stubFound == "" && stubWhy != "" {
			extra["stub_tried"] = stubWhy
		}
	}
	// The status's extra is lists of rows (ADR-135): one row, what this Nginx is.
	res.Extra = map[string]any{"nginx": []map[string]any{extra}}
	res.Facts = map[string]any{}
	for k, v := range extra {
		res.Facts[k] = v
	}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State, res.Error = integrations.StateError, res.Members[0].Error
	}
	return res
}

// Probe implements integrations.Prober: Nginx needs no user; the test is that a member
// answers, and it says which kind it is and what it found.
func (n *Nginx) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	r := n.Scrape(ctx, t, false)
	out := integrations.ProbeResult{Code: integrations.ProbeOK, Version: r.ServiceVersion, Facts: r.Facts}
	if r.State != integrations.StateOK {
		out.Code, out.Error = integrations.ProbeUnreachable, r.Error
	}
	return out
}

type memberOut struct {
	status   integrations.MemberStatus
	samples  []metrics.Sample
	ingress  bool
	metrics  bool
	stubPath string
	stubWhy  string
	version  string
}

func (n *Nginx) member(ctx context.Context, m integrations.Member) memberOut {
	out := memberOut{status: integrations.MemberStatus{Name: m.Name}}
	host, port, err := net.SplitHostPort(m.Address)
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
	st := n.state(key)
	now := n.Now()
	if st.firstSeen.IsZero() {
		st.firstSeen = now
	}
	if st.kindAt.IsZero() || now.Sub(st.kindAt) > Recheck {
		st.ingress = n.isIngress(ctx, host)
		st.kindAt = now
	}
	if st.ingress {
		out.ingress = true
		samples, version, on := n.ingressMetrics(ctx, host)
		out.metrics, out.version = on, version
		for _, s := range samples {
			out.samples = append(out.samples, s.WithLabels(metrics.Label{Name: "member", Value: m.Name}))
		}
		n.save(key, st)
		return out
	}
	// Plain Nginx: stub_status where it was found, else look again every Recheck.
	wait := Recheck
	if now.Sub(st.firstSeen) < Recheck {
		wait = EarlyRecheck
	}
	if st.stubURL == "" && (!st.stubTried || now.Sub(st.stubAt) > wait) {
		st.stubURL, st.stubWhy = n.findStub(ctx, host, port)
		st.stubAt, st.stubTried = now, true
	}
	if st.stubURL != "" {
		samples, version, err := n.stub(ctx, st.stubURL)
		if err != nil {
			// Gone (config changed): look again next time.
			st.stubURL, st.stubTried = "", false
		} else {
			for _, s := range samples {
				out.samples = append(out.samples, s.WithLabels(metrics.Label{Name: "member", Value: m.Name}))
			}
			out.version = version
			out.stubPath = stubPathOf(st.stubURL)
		}
	}
	if out.stubPath == "" {
		out.stubWhy = st.stubWhy
	}
	n.save(key, st)
	return out
}

func (n *Nginx) state(addr string) memberState {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.members[addr]
}

func (n *Nginx) save(addr string, st memberState) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.members[addr] = st
}

func (n *Nginx) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "watchlog-integrations")
	return n.Client.Do(req)
}

// isIngress: ingress-nginx's controller answers its health check on :10254.
func (n *Nginx) isIngress(ctx context.Context, host string) bool {
	res, err := n.get(ctx, "http://"+net.JoinHostPort(host, n.MetricsPort)+"/healthz")
	if err != nil {
		return false
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64))
	return res.StatusCode == http.StatusOK && strings.TrimSpace(string(b)) == "ok"
}

// kept are the ingress-nginx families read, and the labels each keeps. Everything else
// (path, host, method, canary, the controller's own labels) is summed away. Labels the
// collector sets on every series are renamed so they don't collide: the Ingress's
// `namespace` is ingress_namespace, its backend Service (`service`) is backend, and a
// certificate's `host` is tls_host.
var kept = map[string][]string{
	"nginx_ingress_controller_requests":                        {"namespace", "ingress", "service", "status"},
	"nginx_ingress_controller_request_duration_seconds_bucket": {"namespace", "ingress", "service", "le"},
	"nginx_ingress_controller_request_duration_seconds_sum":    {"namespace", "ingress", "service"},
	"nginx_ingress_controller_request_duration_seconds_count":  {"namespace", "ingress", "service"},
	"nginx_ingress_controller_response_size_sum":               {"namespace", "ingress", "service"},
	"nginx_ingress_controller_nginx_process_connections":       {"state"},
	"nginx_ingress_controller_nginx_process_connections_total": {"state"},
	"nginx_ingress_controller_ssl_expire_time_seconds":         {"namespace", "host", "secret_name"},
	"nginx_ingress_controller_orphan_ingress":                  {"namespace", "ingress", "type"},
	"nginx_ingress_controller_config_last_reload_successful":   {},
	"nginx_ingress_controller_build_info":                      {"release"},
}

var renamed = map[string]string{"namespace": "ingress_namespace", "service": "backend", "host": "tls_host"}

// ingressMetrics reads :10254/metrics; on reports whether the controller serves its
// NGINX metrics at all (--enable-metrics).
func (n *Nginx) ingressMetrics(ctx context.Context, host string) (out []metrics.Sample, version string, on bool) {
	res, err := n.get(ctx, "http://"+net.JoinHostPort(host, n.MetricsPort)+"/metrics")
	if err != nil {
		return nil, "", false
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, "", false
	}
	parsed, _ := promtext.Parse(io.LimitReader(res.Body, MaxBody), func(name string) bool {
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
		if p.Name == "nginx_ingress_controller_build_info" {
			version = strings.TrimPrefix(p.Labels["release"], "v")
			continue
		}
		// The controller's self-signed default certificate ("_") is not anyone's.
		if p.Name == "nginx_ingress_controller_ssl_expire_time_seconds" && p.Labels["host"] == "_" {
			continue
		}
		var l []string
		for _, k := range kept[p.Name] {
			if v := p.Labels[k]; v != "" {
				name := k
				if r, ok := renamed[k]; ok {
					name = r
				}
				l = append(l, name, v)
			}
		}
		k := key{p.Name, strings.Join(l, "\x00")}
		if _, seen := sums[k]; !seen {
			if len(order) >= MaxSeries {
				continue
			}
			order = append(order, k)
			labelsOf[k] = l
		}
		sums[k] += p.Value
	}
	on = len(order) > 0
	for _, k := range order {
		out = append(out, metrics.New(k.name, sums[k], labelsOf[k]...))
	}
	return out, version, on
}

// findStub looks for stub_status on the service's port, then on StubPort. When none
// answers it, why says what each place answered (":8080/stub_status: 404").
func (n *Nginx) findStub(ctx context.Context, host, port string) (url, why string) {
	ports := []string{port}
	if port != n.StubPort {
		ports = append(ports, n.StubPort)
	}
	var tried []string
	for _, p := range ports {
		for _, path := range StubPaths {
			u := "http://" + net.JoinHostPort(host, p) + path
			_, _, err := n.stub(ctx, u)
			if err == nil {
				return u, ""
			}
			tried = append(tried, ":"+p+path+": "+stubError(err))
			if ctx.Err() != nil {
				return "", strings.Join(tried, "; ")
			}
		}
	}
	return "", strings.Join(tried, "; ")
}

// stubError is a short reason a place isn't stub_status: an HTTP code, "not
// stub_status" for another page, or the connection error.
func stubError(err error) string {
	var code statusError
	switch {
	case errors.As(err, &code):
		return strconv.Itoa(int(code))
	case errors.Is(err, errNotStub):
		return "not stub_status"
	}
	return shortError(err)
}

type statusError int

func (e statusError) Error() string { return "HTTP " + strconv.Itoa(int(e)) }

func stubPathOf(url string) string {
	rest := strings.TrimPrefix(url, "http://")
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		hostPort, path := rest[:i], rest[i:]
		if _, p, err := net.SplitHostPort(hostPort); err == nil {
			return ":" + p + path
		}
	}
	return url
}

var errNotStub = errors.New("not stub_status")

// stub reads one stub_status page:
//
//	Active connections: 291
//	server accepts handled requests
//	 16630948 16630948 31070465
//	Reading: 6 Writing: 179 Waiting: 106
func (n *Nginx) stub(ctx context.Context, url string) ([]metrics.Sample, string, error) {
	res, err := n.get(ctx, url)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, "", statusError(res.StatusCode)
	}
	samples, err := ParseStub(io.LimitReader(res.Body, 4096))
	if err != nil {
		return nil, "", err
	}
	version := ""
	if s := res.Header.Get("Server"); strings.HasPrefix(s, "nginx/") {
		version = strings.TrimPrefix(s, "nginx/")
	}
	return samples, version, nil
}

// ParseStub reads stub_status's four lines into watchlog_nginx_* series.
func ParseStub(r io.Reader) ([]metrics.Sample, error) {
	sc := bufio.NewScanner(r)
	var lines []string
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) < 4 || !strings.HasPrefix(lines[0], "Active connections:") {
		return nil, errNotStub
	}
	num := func(s string) (float64, bool) {
		v, err := strconv.ParseFloat(s, 64)
		return v, err == nil
	}
	active, ok := num(strings.TrimSpace(strings.TrimPrefix(lines[0], "Active connections:")))
	if !ok {
		return nil, errNotStub
	}
	counts := strings.Fields(lines[2])
	if len(counts) != 3 {
		return nil, errNotStub
	}
	var c [3]float64
	for i, f := range counts {
		if c[i], ok = num(f); !ok {
			return nil, errNotStub
		}
	}
	states := strings.Fields(lines[3]) // Reading: r Writing: w Waiting: x
	if len(states) != 6 {
		return nil, errNotStub
	}
	out := []metrics.Sample{
		metrics.New("watchlog_nginx_connections_active", active),
		metrics.New("watchlog_nginx_connections_accepted_total", c[0]),
		metrics.New("watchlog_nginx_connections_handled_total", c[1]),
		metrics.New("watchlog_nginx_requests_total", c[2]),
	}
	for i := 0; i < 6; i += 2 {
		v, ok := num(states[i+1])
		if !ok {
			return nil, errNotStub
		}
		out = append(out, metrics.New("watchlog_nginx_connections", v, "state", strings.ToLower(strings.TrimSuffix(states[i], ":"))))
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func shortError(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && strings.HasPrefix(msg, "dial ") {
		msg = msg[i+2:]
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}
