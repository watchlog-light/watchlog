// SPDX-License-Identifier: AGPL-3.0-only

// loadgen simulates many WatchLog Cloud orgs, each with agents that write and heartbeat
// like real ones, for the Cloud load test (Cloud slice 9, ADR-177 and ADR-180).
//
//	loadgen setup -web http://127.0.0.1:8084 -internal http://<backend>:4082 \
//	    -internal-token-file token -state state.json        # orgs, clusters, real tokens
//	loadgen run -ingest http://127.0.0.1:8085 -web http://127.0.0.1:8084 \
//	    -state state.json -ramp 10m -duration 45m             # the load, a report a minute
//	loadgen sizes                                           # series and bytes per write
//
// setup signs every org up through the Cloud's public API (signup, sign-in, /me, a cluster or
// Docker fleet with its first token, as a person in the wizard would) and turns the Pro
// orgs on through the internal API (the beta switch the billing service uses). Each
// simulated visitor has its own X-Real-IP, as the host's nginx would pass it.
//
// run starts one goroutine per agent. A node or Docker host sends, every 15 s like the
// agent (cmd/watchlog-agent's -interval), one remote_write (the agent's encoder, the
// series of a real node from templates.json.gz) and one heartbeat; a Kubernetes cluster's
// cluster-agent does the same with its own series and sends an objects snapshot every
// 10 minutes (internal/k8s.SnapshotInterval); a Docker agent sends its inventory snapshot
// every 10 minutes (runner.InventoryResend). Agents start spread over the ramp. Every org
// also reads, every -read-every, its first cluster's overview and one chart, as an open
// dashboard would. Failed requests are counted, not retried (the agent would replay them).
//
// templates.json.gz holds the series of real agents (labels and one value each), taken from
// VictoriaMetrics in the Cloud test VM: two Kubernetes nodes and the cluster-level series
// of the live demo's kit (its integrations' series left out), and two Docker hosts (the
// demo's Docker host and the test VM itself), with cluster_id and the node or host label
// removed (the generator sets the node's own).
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	agentVersion     = "0.6.0"
	writeInterval    = 15 * time.Second
	snapshotInterval = 10 * time.Minute
	userAgent        = "watchlog-agent/" + agentVersion + " (loadgen)"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: loadgen setup|run|sizes [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "setup":
		err = setupCmd(os.Args[2:])
	case "run":
		err = runCmd(os.Args[2:])
	case "sizes":
		err = sizesCmd(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "loadgen:", err)
		os.Exit(1)
	}
}

// ── Templates ────────────────────────────────────────────────────────────────────────

type series struct {
	name    string
	labels  []Label
	value   float64
	counter bool
}

type templates struct {
	K8sNode, DockerHost, ClusterAgent [][]series
}

func loadTemplates(path string) (*templates, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	var raw map[string][][][2]json.RawMessage
	if err := json.NewDecoder(zr).Decode(&raw); err != nil {
		return nil, err
	}
	conv := func(sets [][][2]json.RawMessage) ([][]series, error) {
		var out [][]series
		for _, set := range sets {
			var ss []series
			for _, pair := range set {
				var labels map[string]string
				var v float64
				if err := json.Unmarshal(pair[0], &labels); err != nil {
					return nil, err
				}
				if err := json.Unmarshal(pair[1], &v); err != nil {
					return nil, err
				}
				s := series{name: labels["__name__"], value: v}
				delete(labels, "__name__")
				for k, val := range labels {
					s.labels = append(s.labels, Label{k, val})
				}
				sort.Slice(s.labels, func(i, j int) bool { return s.labels[i].Name < s.labels[j].Name })
				s.counter = isCounter(s.name)
				ss = append(ss, s)
			}
			out = append(out, ss)
		}
		return out, nil
	}
	t := &templates{}
	if t.K8sNode, err = conv(raw["k8s_node"]); err != nil {
		return nil, err
	}
	if t.DockerHost, err = conv(raw["docker_host"]); err != nil {
		return nil, err
	}
	if t.ClusterAgent, err = conv(raw["cluster_agent"]); err != nil {
		return nil, err
	}
	return t, nil
}

func isCounter(name string) bool {
	for _, s := range []string{"_total", "_bucket", "_count", "_sum"} {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}

func labelValues(set []series, name string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range set {
		for _, l := range s.labels {
			if l.Name == name && l.Value != "" && !seen[l.Value] {
				seen[l.Value] = true
				out = append(out, l.Value)
			}
		}
	}
	sort.Strings(out)
	return out
}

func sizesCmd(args []string) error {
	fs := flag.NewFlagSet("sizes", flag.ExitOnError)
	tplPath := fs.String("templates", "templates.json.gz", "series templates")
	_ = fs.Parse(args)
	t, err := loadTemplates(*tplPath)
	if err != nil {
		return err
	}
	show := func(kind, hostLabel string, sets [][]series) {
		for i, set := range sets {
			a := newAgent(kind, "example-node-01", hostLabel, set)
			raw := Marshal(a.samples(), time.Now().UnixMilli())
			body := Encode(a.samples(), time.Now().UnixMilli())
			fmt.Printf("%-13s %d: %5d series, %7d bytes protobuf, %6d bytes snappy (what the agent sends)\n",
				kind, i, len(set), len(raw), len(body))
		}
	}
	show("k8s_node", "node", t.K8sNode)
	show("docker_host", "host", t.DockerHost)
	show("cluster_agent", "", t.ClusterAgent)
	return nil
}

// ── The plan: orgs, clusters, nodes ──────────────────────────────────────────────────

type orgPlan struct {
	Index    int            `json:"index"`
	Plan     string         `json:"plan"`
	Email    string         `json:"email"`
	Password string         `json:"password,omitempty"`
	IP       string         `json:"ip"`
	ID       string         `json:"id,omitempty"`
	Cookie   string         `json:"cookie,omitempty"`
	Clusters []*clusterPlan `json:"clusters"`
}

type clusterPlan struct {
	Name  string   `json:"name"`
	Kind  string   `json:"kind"` // kubernetes | docker
	ID    string   `json:"id,omitempty"`
	Token string   `json:"token,omitempty"`
	Nodes []string `json:"nodes"`
}

// plan lays out free + pro orgs with nodes in all: Free orgs have one cluster or Docker
// fleet of 1–5 nodes, Pro orgs share the rest over 1–3 clusters, skewed as real fleets
// are. dockerShare of the clusters are Docker fleets.
func plan(free, pro, nodes int, dockerShare float64, seed uint64) []*orgPlan {
	rng := mrand.New(mrand.NewPCG(seed, seed^0x5eed))
	var orgs []*orgPlan
	kind := func() string {
		if rng.Float64() < dockerShare {
			return "docker"
		}
		return "kubernetes"
	}
	names := func(o, c int, k string, n int) []string {
		var out []string
		for i := 1; i <= n; i++ {
			if k == "docker" {
				out = append(out, fmt.Sprintf("o%03d-c%d-host-%02d", o, c, i))
			} else {
				out = append(out, fmt.Sprintf("o%03d-c%d-node-%02d", o, c, i))
			}
		}
		return out
	}
	used := 0
	for i := 0; i < free; i++ {
		n := 1 + rng.IntN(5)
		used += n
		k := kind()
		orgs = append(orgs, &orgPlan{Index: len(orgs), Plan: "free", Clusters: []*clusterPlan{{Name: "c1", Kind: k, Nodes: names(len(orgs), 1, k, n)}}})
	}
	// Pro: weights from a long-tailed draw, at least 2 nodes each.
	rest := nodes - used
	weights := make([]float64, pro)
	sum := 0.0
	for i := range weights {
		weights[i] = math.Exp(rng.NormFloat64() * 0.8)
		sum += weights[i]
	}
	counts := make([]int, pro)
	given := 0
	for i := range counts {
		counts[i] = max(2, int(math.Floor(float64(rest-2*pro)*weights[i]/sum))+2)
		given += counts[i]
	}
	for i := 0; given != rest && pro > 0; i = (i + 1) % pro {
		if given < rest {
			counts[i]++
			given++
		} else if counts[i] > 2 {
			counts[i]--
			given--
		}
	}
	for i := 0; i < pro; i++ {
		o := &orgPlan{Index: len(orgs), Plan: "pro"}
		nc := min(1+rng.IntN(3), counts[i])
		left := counts[i]
		for c := 1; c <= nc; c++ {
			n := left / (nc - c + 1)
			if c == 1 {
				n = left - (nc-1)*(left/nc)
			}
			left -= n
			k := kind()
			o.Clusters = append(o.Clusters, &clusterPlan{Name: fmt.Sprintf("c%d", c), Kind: k, Nodes: names(o.Index, c, k, n)})
		}
		orgs = append(orgs, o)
	}
	for _, o := range orgs {
		o.Email = fmt.Sprintf("owner@org%03d.load-test.example", o.Index)
		o.IP = fmt.Sprintf("10.200.%d.%d", o.Index/250, o.Index%250+1)
	}
	return orgs
}

// ── setup ────────────────────────────────────────────────────────────────────────────

type client struct {
	http *http.Client
}

func newClient() *client {
	tr := &http.Transport{MaxIdleConns: 2048, MaxIdleConnsPerHost: 1024, IdleConnTimeout: 90 * time.Second}
	return &client{http: &http.Client{Transport: tr, Timeout: 30 * time.Second}}
}

// do sends one request and returns the status, the body and the response's headers.
func (c *client) do(ctx context.Context, method, url string, body []byte, headers map[string]string) (int, []byte, http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return res.StatusCode, b, res.Header, nil
}

// webHeaders are a browser's on the dashboard, from the org's own address.
func webHeaders(o *orgPlan) map[string]string {
	h := map[string]string{
		"Content-Type":   "application/json",
		"Sec-Fetch-Site": "same-origin",
		"X-Real-IP":      o.IP,
		"User-Agent":     "Mozilla/5.0 (loadgen)",
	}
	if o.Cookie != "" {
		h["Cookie"] = o.Cookie
	}
	return h
}

func setupCmd(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	web := fs.String("web", "http://127.0.0.1:8084", "the dashboard's address (the web container)")
	internal := fs.String("internal", "", "the backend's internal API, http://<ip>:4082")
	tokenFile := fs.String("internal-token-file", "", "file holding WATCHLOG_INTERNAL_TOKEN")
	statePath := fs.String("state", "state.json", "where the orgs and their tokens are written (keep it private)")
	free := fs.Int("free", 150, "Free orgs")
	pro := fs.Int("pro", 50, "Pro (beta) orgs")
	nodes := fs.Int("nodes", 1000, "nodes and Docker hosts in all")
	dockerShare := fs.Float64("docker-share", 0.3, "share of clusters that are Docker fleets")
	seed := fs.Uint64("seed", 1, "seed of the plan")
	workers := fs.Int("workers", 4, "orgs set up at once")
	_ = fs.Parse(args)
	tok, err := os.ReadFile(*tokenFile)
	if err != nil {
		return fmt.Errorf("internal token: %w", err)
	}
	internalHeaders := map[string]string{
		"Authorization":    "Bearer " + strings.TrimSpace(string(tok)),
		"Content-Type":     "application/json",
		"X-WatchLog-Staff": "load-test@watchlog.io",
	}
	c := newClient()
	ctx := context.Background()
	st, b, _, err := c.do(ctx, http.MethodPut, *internal+"/internal/admin/signup-mode", []byte(`{"mode":"public"}`), internalHeaders)
	if err != nil || st != 200 {
		return fmt.Errorf("signup mode public: %d %s %v", st, b, err)
	}
	orgs := plan(*free, *pro, *nodes, *dockerShare, *seed)
	jobs := make(chan *orgPlan)
	errs := make(chan error, len(orgs))
	var wg sync.WaitGroup
	var done atomic.Int64
	t0 := time.Now()
	for range *workers {
		wg.Go(func() {
			for o := range jobs {
				if err := setupOrg(ctx, c, *web, *internal, internalHeaders, o); err != nil {
					errs <- fmt.Errorf("org %d: %w", o.Index, err)
				}
				if n := done.Add(1); n%20 == 0 {
					fmt.Printf("setup: %d/%d orgs (%.0f s)\n", n, len(orgs), time.Since(t0).Seconds())
				}
			}
		})
	}
	for _, o := range orgs {
		jobs <- o
	}
	close(jobs)
	wg.Wait()
	close(errs)
	var all []error
	for e := range errs {
		all = append(all, e)
	}
	out, _ := json.MarshalIndent(orgs, "", " ")
	if err := os.WriteFile(*statePath, out, 0o600); err != nil {
		return err
	}
	summarize(orgs)
	fmt.Printf("setup: %d orgs in %.0f s, %d failed\n", len(orgs), time.Since(t0).Seconds(), len(all))
	return errors.Join(all...)
}

func summarize(orgs []*orgPlan) {
	var free, pro, k8s, docker, fn, pn, dn int
	for _, o := range orgs {
		if o.Plan == "pro" {
			pro++
		} else {
			free++
		}
		for _, cl := range o.Clusters {
			if cl.Kind == "docker" {
				docker++
				dn += len(cl.Nodes)
			} else {
				k8s++
			}
			if o.Plan == "pro" {
				pn += len(cl.Nodes)
			} else {
				fn += len(cl.Nodes)
			}
		}
	}
	fmt.Printf("plan: %d Free orgs (%d nodes), %d Pro orgs (%d nodes); %d Kubernetes clusters, %d Docker fleets (%d hosts)\n",
		free, fn, pro, pn, k8s, docker, dn)
}

func setupOrg(ctx context.Context, c *client, web, internal string, ih map[string]string, o *orgPlan) error {
	pw := make([]byte, 12)
	_, _ = rand.Read(pw)
	o.Password = "Lt-" + hex.EncodeToString(pw) + "!a9"
	body, _ := json.Marshal(map[string]string{"email": o.Email, "password": o.Password, "name": fmt.Sprintf("Load test %03d", o.Index)})
	st, b, _, err := c.do(ctx, http.MethodPost, web+"/api/v1/auth/signup", body, webHeaders(o))
	if err != nil || st != 201 {
		return fmt.Errorf("signup: %d %s %v", st, b, err)
	}
	body, _ = json.Marshal(map[string]string{"email": o.Email, "password": o.Password})
	st, b, h, err := c.do(ctx, http.MethodPost, web+"/api/v1/auth/login", body, webHeaders(o))
	if err != nil || st != 200 {
		return fmt.Errorf("sign in: %d %s %v", st, b, err)
	}
	for _, sc := range h.Values("Set-Cookie") {
		if strings.HasPrefix(sc, "wl_session=") {
			o.Cookie = strings.SplitN(sc, ";", 2)[0]
		}
	}
	if o.Cookie == "" {
		return errors.New("sign in: no session cookie")
	}
	st, b, _, err = c.do(ctx, http.MethodGet, web+"/api/v1/me", nil, webHeaders(o))
	if err != nil || st != 200 {
		return fmt.Errorf("me: %d %s %v", st, b, err)
	}
	var me struct {
		User struct {
			Org struct {
				ID string `json:"id"`
			} `json:"org"`
		} `json:"user"`
	}
	if err := json.Unmarshal(b, &me); err != nil || me.User.Org.ID == "" {
		return fmt.Errorf("me: no org id in %s", b)
	}
	o.ID = me.User.Org.ID
	if o.Plan == "pro" {
		body, _ = json.Marshal(map[string]string{"plan": "pro", "source": "beta", "betaUntil": time.Now().AddDate(0, 3, 0).UTC().Format(time.RFC3339)})
		st, b, _, err = c.do(ctx, http.MethodPut, internal+"/internal/orgs/"+o.ID+"/entitlements", body, ih)
		if err != nil || st != 200 {
			return fmt.Errorf("pro: %d %s %v", st, b, err)
		}
	}
	for _, cl := range o.Clusters {
		body, _ = json.Marshal(map[string]string{"name": fmt.Sprintf("org%03d-%s", o.Index, cl.Name), "kind": cl.Kind})
		st, b, _, err = c.do(ctx, http.MethodPost, web+"/api/v1/clusters", body, webHeaders(o))
		if err != nil || st != 201 {
			return fmt.Errorf("cluster %s: %d %s %v", cl.Name, st, b, err)
		}
		var created struct {
			Cluster struct {
				ID string `json:"id"`
			} `json:"cluster"`
			Token struct {
				Value string `json:"value"`
			} `json:"token"`
		}
		if err := json.Unmarshal(b, &created); err != nil || created.Token.Value == "" {
			return fmt.Errorf("cluster %s: no token in the answer", cl.Name)
		}
		cl.ID, cl.Token = created.Cluster.ID, created.Token.Value
	}
	return nil
}

// ── run ──────────────────────────────────────────────────────────────────────────────

// agent is one simulated agent: its series and their current values.
type agent struct {
	kind   string // k8s_node | docker_host | cluster_agent
	id     string // X-WatchLog-Agent
	host   Label
	set    []series
	values []float64
	static []bool
	rng    *mrand.Rand
}

func newAgent(kind, id, hostLabel string, set []series) *agent {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id))
	seed := h.Sum64()
	a := &agent{kind: kind, id: id, set: set, values: make([]float64, len(set)), static: make([]bool, len(set)),
		rng: mrand.New(mrand.NewPCG(seed, seed>>1))}
	if hostLabel != "" {
		a.host = Label{hostLabel, id}
	}
	for i, s := range set {
		// Each node's values start apart from the template's; most gauges (limits,
		// capacities, info) stay put, the rest move a little every interval.
		a.values[i] = s.round(s.value * (0.5 + a.rng.Float64()))
		a.static[i] = !s.counter && a.rng.Float64() < 0.7
	}
	return a
}

// round keeps a value to its series' precision, as agents report it: whole numbers
// (bytes, counts) stay whole, the rest keep three decimals. Random float64 noise in every
// bit would not compress like real samples do (the first 9b run: about 10 bytes a sample
// against 2.5 for the real agents' data).
func (s series) round(v float64) float64 {
	if s.value == math.Trunc(s.value) {
		return math.Round(v)
	}
	return math.Round(v*1000) / 1000
}

// tick moves the values one interval on: counters grow, moving gauges wander.
func (a *agent) tick() {
	for i, s := range a.set {
		switch {
		case s.counter:
			a.values[i] = s.round(a.values[i] + a.rng.Float64()*math.Max(1, math.Abs(s.value)*2e-4))
		case !a.static[i]:
			a.values[i] = s.round(a.values[i] * (1 + a.rng.NormFloat64()*0.02))
		}
	}
}

func (a *agent) samples() []Sample {
	out := make([]Sample, len(a.set))
	for i, s := range a.set {
		labels := s.labels
		if a.host.Name != "" {
			labels = append(labels[:len(labels):len(labels)], a.host)
		}
		out[i] = Sample{Name: s.name, Labels: labels, Value: a.values[i]}
	}
	return out
}

// ── statistics ───────────────────────────────────────────────────────────────────────

type endpointStats struct {
	mu       sync.Mutex
	statuses map[int]int64
	lat      []float64 // ms, this report window
	hold     []float64 // ms, the whole hold
	holdSt   map[int]int64
	bytes    int64
}

type stats struct {
	mu   sync.Mutex
	eps  map[string]*endpointStats
	hold atomic.Bool
}

func (s *stats) ep(name string) *endpointStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eps == nil {
		s.eps = map[string]*endpointStats{}
	}
	e := s.eps[name]
	if e == nil {
		e = &endpointStats{statuses: map[int]int64{}, holdSt: map[int]int64{}}
		s.eps[name] = e
	}
	return e
}

func (s *stats) record(name string, status int, d time.Duration, bytes int) {
	e := s.ep(name)
	ms := float64(d.Microseconds()) / 1000
	e.mu.Lock()
	e.statuses[status]++
	e.lat = append(e.lat, ms)
	e.bytes += int64(bytes)
	if s.hold.Load() {
		e.hold = append(e.hold, ms)
		e.holdSt[status]++
	}
	e.mu.Unlock()
}

func pct(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return s[min(len(s)-1, int(math.Ceil(p*float64(len(s))))-1)]
}

type window struct {
	Requests int           `json:"requests"`
	PerSec   float64       `json:"per_s"`
	P50      float64       `json:"p50_ms"`
	P95      float64       `json:"p95_ms"`
	P99      float64       `json:"p99_ms"`
	Status   map[int]int64 `json:"status"`
	Bytes    int64         `json:"bytes,omitempty"`
}

// report prints and resets the window's numbers.
func (s *stats) report(elapsed time.Duration, phase string, agents int64) map[string]window {
	s.mu.Lock()
	names := make([]string, 0, len(s.eps))
	for n := range s.eps {
		names = append(names, n)
	}
	s.mu.Unlock()
	sort.Strings(names)
	out := map[string]window{}
	for _, n := range names {
		e := s.ep(n)
		e.mu.Lock()
		w := window{Requests: len(e.lat), PerSec: float64(len(e.lat)) / elapsed.Seconds(),
			P50: pct(e.lat, 0.5), P95: pct(e.lat, 0.95), P99: pct(e.lat, 0.99), Status: e.statuses, Bytes: e.bytes}
		e.lat, e.statuses, e.bytes = nil, map[int]int64{}, 0
		e.mu.Unlock()
		out[n] = w
	}
	line, _ := json.Marshal(map[string]any{"time": time.Now().UTC().Format(time.RFC3339), "phase": phase, "agents": agents, "endpoints": out})
	fmt.Println(string(line))
	return out
}

func (s *stats) holdSummary(d time.Duration) map[string]window {
	out := map[string]window{}
	s.mu.Lock()
	defer s.mu.Unlock()
	for n, e := range s.eps {
		e.mu.Lock()
		out[n] = window{Requests: len(e.hold), PerSec: float64(len(e.hold)) / d.Seconds(),
			P50: pct(e.hold, 0.5), P95: pct(e.hold, 0.95), P99: pct(e.hold, 0.99), Status: e.holdSt}
		e.mu.Unlock()
	}
	return out
}

func runCmd(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	ingest := fs.String("ingest", "http://127.0.0.1:8085", "the ingest address (the backend's public port)")
	web := fs.String("web", "http://127.0.0.1:8084", "the dashboard's address, for the reads")
	statePath := fs.String("state", "state.json", "written by setup")
	tplPath := fs.String("templates", "templates.json.gz", "series templates")
	ramp := fs.Duration("ramp", 10*time.Minute, "agents start spread over this")
	duration := fs.Duration("duration", 45*time.Minute, "the whole run, ramp included")
	readEvery := fs.Duration("read-every", 5*time.Minute, "each org reads its overview and a chart this often (0: no reads)")
	reportEvery := fs.Duration("report", time.Minute, "a report line this often")
	summaryPath := fs.String("summary", "", "the hold's numbers as JSON")
	_ = fs.Parse(args)
	raw, err := os.ReadFile(*statePath)
	if err != nil {
		return err
	}
	var orgs []*orgPlan
	if err := json.Unmarshal(raw, &orgs); err != nil {
		return err
	}
	tpl, err := loadTemplates(*tplPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *duration)
	defer cancel()

	c := newClient()
	st := &stats{}
	type job struct {
		a       *agent
		cl      *clusterPlan
		objects func() [][]byte // snapshot bodies, nil for none
	}
	var jobs []job
	for _, o := range orgs {
		for _, cl := range o.Clusters {
			if cl.Token == "" {
				continue
			}
			if cl.Kind == "kubernetes" {
				ca := newAgent("cluster_agent", "cluster-agent", "", tpl.ClusterAgent[0])
				cl := cl
				jobs = append(jobs, job{a: ca, cl: cl, objects: func() [][]byte { return k8sSnapshot(cl, tpl) }})
			}
			for i, n := range cl.Nodes {
				if cl.Kind == "docker" {
					set := tpl.DockerHost[(o.Index+i)%len(tpl.DockerHost)]
					a := newAgent("docker_host", n, "host", set)
					jobs = append(jobs, job{a: a, cl: cl, objects: func() [][]byte { return [][]byte{dockerSnapshot(a)} }})
				} else {
					set := tpl.K8sNode[(o.Index+i)%len(tpl.K8sNode)]
					jobs = append(jobs, job{a: newAgent("k8s_node", n, "node", set), cl: cl})
				}
			}
		}
	}
	mrand.Shuffle(len(jobs), func(i, j int) { jobs[i], jobs[j] = jobs[j], jobs[i] })
	var nodes int
	for _, j := range jobs {
		if j.a.kind != "cluster_agent" {
			nodes++
		}
	}
	fmt.Printf("run: %d agents (%d nodes and Docker hosts, %d cluster-agents), ramp %s, run %s\n",
		len(jobs), nodes, len(jobs)-nodes, *ramp, *duration)

	var running atomic.Int64
	var wg sync.WaitGroup
	start := time.Now()
	for i, j := range jobs {
		delay := time.Duration(float64(*ramp) * float64(i) / float64(len(jobs)))
		wg.Go(func() {
			if !sleepCtx(ctx, delay) {
				return
			}
			running.Add(1)
			runAgent(ctx, c, *ingest, j.cl.Token, j.a, j.objects, st)
		})
	}
	if *readEvery > 0 {
		for _, o := range orgs {
			if o.Cookie == "" || len(o.Clusters) == 0 || o.Clusters[0].ID == "" {
				continue
			}
			wg.Go(func() { runReader(ctx, c, *web, o, *readEvery, *ramp, st) })
		}
	}
	// Reports; the hold starts when the ramp ends.
	go func() {
		t := time.NewTicker(*reportEvery)
		defer t.Stop()
		last := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				phase := "ramp"
				if now.Sub(start) >= *ramp {
					phase = "hold"
					st.hold.Store(true)
				}
				st.report(now.Sub(last), phase, running.Load())
				last = now
			}
		}
	}()
	wg.Wait()
	holdFor := time.Since(start) - *ramp
	if holdFor > 0 && *summaryPath != "" {
		out, _ := json.MarshalIndent(map[string]any{
			"started": start.UTC().Format(time.RFC3339), "ramp_s": ramp.Seconds(), "hold_s": holdFor.Seconds(),
			"agents": len(jobs), "nodes": nodes, "endpoints": st.holdSummary(holdFor),
		}, "", " ")
		if err := os.WriteFile(*summaryPath, out, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func runAgent(ctx context.Context, c *client, ingest, token string, a *agent, objects func() [][]byte, st *stats) {
	mode := map[string]string{"k8s_node": "node", "docker_host": "docker", "cluster_agent": "cluster"}[a.kind]
	headers := func(extra map[string]string) map[string]string {
		h := map[string]string{"Authorization": "Bearer " + token, "User-Agent": userAgent, "X-WatchLog-Agent": a.id}
		for k, v := range extra {
			h[k] = v
		}
		return h
	}
	writeH := headers(map[string]string{"Content-Type": "application/x-protobuf", "Content-Encoding": "snappy",
		"X-Prometheus-Remote-Write-Version": "0.1.0"})
	jsonH := headers(map[string]string{"Content-Type": "application/json"})
	gzH := headers(map[string]string{"Content-Type": "application/json", "Content-Encoding": "gzip"})
	caps := map[string]any{"ebpf": "enabled", "cgroup": "v2", "node_scope": "host"}
	if a.kind == "k8s_node" {
		caps["kubelet_tls"] = "verified"
	}
	post := func(name, url string, body []byte, h map[string]string) {
		t0 := time.Now()
		status, _, _, err := c.do(ctx, http.MethodPost, url, body, h)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			status = 0
		}
		st.record(name, status, time.Since(t0), len(body))
	}
	var lastSnapshot time.Time
	t := time.NewTicker(writeInterval)
	defer t.Stop()
	for {
		a.tick()
		post("write", ingest+"/ingest/v1/write", Encode(a.samples(), time.Now().UnixMilli()), writeH)
		hb, _ := json.Marshal(map[string]any{"agent_version": agentVersion, "mode": mode, "node": a.id, "capabilities": caps, "series": len(a.set)})
		post("heartbeat", ingest+"/ingest/v1/heartbeat", hb, jsonH)
		if objects != nil && time.Since(lastSnapshot) >= snapshotInterval {
			lastSnapshot = time.Now()
			for _, body := range objects() {
				post("objects", ingest+"/ingest/v1/objects", gz(body), gzH)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func runReader(ctx context.Context, c *client, web string, o *orgPlan, every, ramp time.Duration, st *stats) {
	// The first read after the org's agents have started, then every interval.
	if !sleepCtx(ctx, ramp/2+time.Duration(mrand.Int64N(int64(every)))) {
		return
	}
	cl := o.Clusters[0]
	metric := "node.cpu.usage"
	if cl.Kind == "docker" {
		metric = "container.cpu.usage"
	}
	for {
		get := func(name, method, url string, body []byte) {
			t0 := time.Now()
			status, _, _, err := c.do(ctx, method, url, body, webHeaders(o))
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				status = 0
			}
			st.record(name, status, time.Since(t0), 0)
		}
		get("read_overview", http.MethodGet, web+"/api/v1/clusters/"+cl.ID+"/overview?range=3600", nil)
		now := time.Now().Unix()
		q, _ := json.Marshal(map[string]any{"clusterId": cl.ID, "metric": metric, "from": now - 3600, "to": now})
		get("read_chart", http.MethodPost, web+"/api/v1/query/range", q)
		if !sleepCtx(ctx, every) {
			return
		}
	}
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func hexID(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "/")))
	return hex.EncodeToString(h[:])
}

// dockerSnapshot is a Docker agent's inventory snapshot: one entry per container its
// series name.
func dockerSnapshot(a *agent) []byte {
	var containers []map[string]any
	project := map[string]string{}
	image := map[string]string{}
	for _, s := range a.set {
		var name, proj, img string
		for _, l := range s.labels {
			switch l.Name {
			case "container":
				name = l.Value
			case "compose_project":
				proj = l.Value
			case "image":
				img = l.Value
			}
		}
		if name != "" && proj != "" {
			project[name] = proj
		}
		if name != "" && img != "" {
			image[name] = img
		}
	}
	for _, name := range labelValues(a.set, "container") {
		c := map[string]any{
			"id": hexID(a.id, name), "name": name, "image": cmp(image[name], "app:latest"), "state": "running",
			"status": "Up 3 hours", "restart_count": 0, "exit_code": 0, "oom_killed": false,
			"created_at": time.Now().Add(-3 * time.Hour).Unix(), "started_at": time.Now().Add(-3 * time.Hour).UTC().Format(time.RFC3339Nano),
		}
		if p := project[name]; p != "" {
			c["compose_project"], c["compose_service"] = p, name
		}
		containers = append(containers, c)
	}
	b, _ := json.Marshal(map[string]any{"kind": "snapshot", "source": "docker", "node": a.id, "inventory": map[string]any{
		"host":       map[string]string{"docker_version": "29.0.0", "api_version": "1.52", "os": "linux", "arch": "arm64", "kernel_version": "6.8.0"},
		"containers": containers,
	}})
	return b
}

func cmp(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// k8sSnapshot is a cluster-agent's objects snapshot: the namespaces, nodes and pods its
// nodes' series name (each node runs the pods of its template), in chunks of 2,000.
func k8sSnapshot(cl *clusterPlan, tpl *templates) [][]byte {
	var objs []map[string]any
	nsSeen := map[string]bool{}
	for i, node := range cl.Nodes {
		objs = append(objs, map[string]any{"kind": "Node", "uid": hexID(cl.ID, "node", node), "name": node,
			"spec":   map[string]any{"labels": map[string]string{"kubernetes.io/hostname": node}},
			"status": map[string]any{"ready": true, "capacity": map[string]string{"cpu": "4", "memory": "16Gi"}}})
		set := tpl.K8sNode[i%len(tpl.K8sNode)]
		pods := map[string]string{}
		for _, s := range set {
			var ns, pod string
			for _, l := range s.labels {
				if l.Name == "namespace" {
					ns = l.Value
				}
				if l.Name == "pod" {
					pod = l.Value
				}
			}
			if ns != "" && pod != "" {
				pods[ns+"/"+pod] = ns
			}
		}
		keys := make([]string, 0, len(pods))
		for k := range pods {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			ns, pod := pods[k], k[strings.Index(k, "/")+1:]
			if !nsSeen[ns] {
				nsSeen[ns] = true
				objs = append(objs, map[string]any{"kind": "Namespace", "uid": hexID(cl.ID, "ns", ns), "name": ns,
					"spec": map[string]any{}, "status": map[string]any{"phase": "Active"}})
			}
			objs = append(objs, map[string]any{"kind": "Pod", "uid": hexID(cl.ID, node, k), "namespace": ns,
				"name": pod + "-" + node[len(node)-2:], "node": node,
				"spec":   map[string]any{"containers": []map[string]string{{"name": pod, "image": "registry.example/" + pod + ":1"}}},
				"status": map[string]any{"phase": "Running", "restarts": 0, "ready": true}})
		}
	}
	id := hexID(cl.ID, time.Now().String())[:16]
	var out [][]byte
	for i := 0; i < len(objs); i += 2000 {
		end := min(i+2000, len(objs))
		body := map[string]any{"source": "kubernetes", "kind": "snapshot", "snapshot_id": id, "objects": objs[i:end]}
		if end == len(objs) {
			body["final"] = true
			body["kinds"] = []string{"Namespace", "Node", "Pod"}
		}
		b, _ := json.Marshal(body)
		out = append(out, b)
	}
	return out
}
