// SPDX-License-Identifier: AGPL-3.0-only

// Package kafka is the Kafka integration (SPEC §4.12, ADR-166): the Kafka protocol's
// admin API through franz-go (kgo, kadm), read-only, no JMX. Every scrape reads
// Metadata (brokers, the controller, partitions, leaders, ISR), ListOffsets (end offsets
// per topic), and the consumer groups with their committed offsets and lag (ListGroups,
// DescribeGroups, OffsetFetch); the heavy scrape adds DescribeLogDirs (sizes),
// DescribeConfigs (retention) and DescribeQuorum (KRaft). No call that changes anything
// is in this file.
//
// Kafka answers Metadata on the address the collector was given, but sends every other
// request to each broker's advertised address, which the collector often can't resolve
// (Compose's `kafka:9092` from the host network, `localhost` in the images' defaults).
// The dialer then connects to the discovered member instead: the one whose pod or
// container name is the advertised host's first label, or the only member.
//
// If a broker exposes a Prometheus endpoint (the JMX exporter: Strimzi's :9404,
// Bitnami's :5556, :7071), its traffic counters are read with promtext into the
// "Broker internals" tab; nothing else depends on it.
package kafka

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
	"github.com/twmb/franz-go/pkg/kversion"
	"github.com/twmb/franz-go/pkg/sasl"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/promtext"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const (
	// TopTopics and TopGroups cap the per-topic and per-group series (ADR-136).
	TopTopics = 200
	TopGroups = 100
	// TopPartitions caps the offline and under-replicated partitions listed one by one.
	TopPartitions = 50
	// TopMembers caps the group members listed.
	TopMembers = 200
	// Remember is how long a group's last members are kept once it is empty.
	Remember = 24 * time.Hour
	// requestTime bounds one admin request.
	requestTime = 5 * time.Second
	// MaxBody bounds one Prometheus endpoint read.
	MaxBody = 8 << 20
	// InternalsRecheck is how long a missing Prometheus endpoint is remembered.
	InternalsRecheck = 10 * time.Minute
)

// InternalsPorts are where a broker's Prometheus endpoint is looked for: Strimzi's JMX
// exporter, Bitnami's, and the port the JMX exporter's docs use.
var InternalsPorts = []string{"9404", "5556", "7071"}

// Kafka is the integration. It remembers each group's last members, so a group that
// lost them can name who they were, and the heavy scrape's numbers for the light ones.
type Kafka struct {
	mu        sync.Mutex
	last      map[string]map[string]lastMembers // target → group
	heavy     map[string]heavyState             // target
	internals map[string]internalsState         // target/member
	Now       func() time.Time
	Client    *http.Client
	Ports     []string
	// Connect is replaced in tests.
	Connect func(ctx context.Context, t integrations.Target) (Admin, error)
}

type lastMembers struct {
	members []member
	leftAt  time.Time // zero while the group has members
	seen    time.Time
}

type member struct {
	clientID, host string
	assigned       int
}

type heavyState struct {
	samples []metrics.Sample
	perms   map[string]string
}

type internalsState struct {
	url     string
	triedAt time.Time
}

// New returns the integration.
func New() *Kafka {
	k := &Kafka{
		last:      map[string]map[string]lastMembers{},
		heavy:     map[string]heavyState{},
		internals: map[string]internalsState{},
		Now:       time.Now,
		Client: &http.Client{
			Timeout:       integrations.DialTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		Ports: InternalsPorts,
	}
	k.Connect = Dial
	return k
}

// Admin is what the collector asks Kafka; the real one is kadm's client, tests give
// recorded answers.
type Admin interface {
	Metadata(ctx context.Context) (kadm.Metadata, error)
	ListEndOffsets(ctx context.Context, topics ...string) (kadm.ListedOffsets, error)
	ListGroups(ctx context.Context) (kadm.ListedGroups, error)
	Lag(ctx context.Context, groups ...string) (kadm.DescribedGroupLags, error)
	LogDirs(ctx context.Context) (kadm.DescribedAllLogDirs, error)
	TopicConfigs(ctx context.Context, topics ...string) (kadm.ResourceConfigs, error)
	Quorum(ctx context.Context) (*kmsg.DescribeQuorumResponse, error)
	// Version is kversion's guess from ApiVersions ("4.1"); empty when unknown.
	Version(ctx context.Context) string
	// Reachable dials a broker's advertised address the way requests do.
	Reachable(ctx context.Context, host string, port int32) bool
	Close()
}

// ----------------------------------------------------------------- connecting

type client struct {
	cl   *kgo.Client
	adm  *kadm.Client
	dial func(ctx context.Context, network, host string) (net.Conn, error)
}

func (c *client) Metadata(ctx context.Context) (kadm.Metadata, error) { return c.adm.Metadata(ctx) }
func (c *client) ListEndOffsets(ctx context.Context, topics ...string) (kadm.ListedOffsets, error) {
	return c.adm.ListEndOffsets(ctx, topics...)
}
func (c *client) ListGroups(ctx context.Context) (kadm.ListedGroups, error) {
	return c.adm.ListGroups(ctx)
}
func (c *client) Lag(ctx context.Context, groups ...string) (kadm.DescribedGroupLags, error) {
	return c.adm.Lag(ctx, groups...)
}
func (c *client) LogDirs(ctx context.Context) (kadm.DescribedAllLogDirs, error) {
	return c.adm.DescribeAllLogDirs(ctx, nil)
}
func (c *client) TopicConfigs(ctx context.Context, topics ...string) (kadm.ResourceConfigs, error) {
	return c.adm.DescribeTopicConfigs(ctx, topics...)
}
func (c *client) Quorum(ctx context.Context) (*kmsg.DescribeQuorumResponse, error) {
	req := kmsg.NewPtrDescribeQuorumRequest()
	t := kmsg.NewDescribeQuorumRequestTopic()
	t.Topic = "__cluster_metadata"
	t.Partitions = append(t.Partitions, kmsg.NewDescribeQuorumRequestTopicPartition())
	req.Topics = append(req.Topics, t)
	return req.RequestWith(ctx, c.cl)
}
func (c *client) Version(ctx context.Context) string {
	res, err := kmsg.NewPtrApiVersionsRequest().RequestWith(ctx, c.cl)
	if err != nil || res.ErrorCode != 0 {
		return ""
	}
	return VersionOf(kversion.FromApiVersionsResponse(res).VersionGuess())
}
func (c *client) Reachable(ctx context.Context, host string, port int32) bool {
	conn, err := c.dial(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(port))))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
func (c *client) Close() { c.cl.Close() }

// VersionOf turns kversion's guess into WatchLog's version: "v4.1" → "4.1",
// "at least v4.1" → "4.1+"; anything else (a custom build) is unknown.
func VersionOf(g string) string {
	switch {
	case strings.HasPrefix(g, "at least v"):
		return strings.TrimPrefix(g, "at least v") + "+"
	case strings.HasPrefix(g, "v"):
		return strings.TrimPrefix(g, "v")
	}
	return ""
}

// Fallback picks the member address to dial for an advertised host the collector can't
// use: a loopback name, or one that doesn't resolve. The member whose name is the host's
// first label (a StatefulSet pod's DNS name), or the only member; "" when neither.
func Fallback(members []integrations.Member, host string) string {
	first := strings.SplitN(host, ".", 2)[0]
	for _, m := range members {
		if m.Name == host || m.Name == first {
			return m.Address
		}
	}
	if len(members) == 1 {
		return members[0].Address
	}
	return ""
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// dialer connects to an advertised address, or to the discovered member when the
// address is loopback or doesn't resolve; with TLS when the listener wants it
// (unverified, as MongoDB's and PostgreSQL's sslmode=prefer).
func dialer(members []integrations.Member, useTLS bool) func(ctx context.Context, network, host string) (net.Conn, error) {
	var (
		mu       sync.Mutex
		resolved = map[string]string{}
	)
	d := &net.Dialer{Timeout: integrations.DialTimeout}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		mu.Lock()
		to, ok := resolved[addr]
		mu.Unlock()
		if !ok {
			to = addr
			host, _, err := net.SplitHostPort(addr)
			if err == nil && net.ParseIP(host) == nil || err == nil && loopback(host) {
				use := loopback(host)
				if !use {
					rctx, cancel := context.WithTimeout(ctx, time.Second)
					_, lerr := net.DefaultResolver.LookupHost(rctx, host)
					cancel()
					use = lerr != nil
				}
				if use {
					if fb := Fallback(members, host); fb != "" {
						to = fb
					}
				}
			}
			mu.Lock()
			resolved[addr] = to
			mu.Unlock()
		}
		conn, err := d.DialContext(ctx, network, to)
		if err != nil || !useTLS {
			return conn, err
		}
		tc := tls.Client(conn, &tls.Config{InsecureSkipVerify: true}) //nolint:gosec // G402: opportunistic TLS, as sslmode=prefer
		if err := tc.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return tc, nil
	}
}

func mechanisms(auth *integrations.Auth) []sasl.Mechanism {
	if auth == nil || auth.Password == "" {
		return nil
	}
	user := auth.Username
	if user == "" {
		user = "watchlog"
	}
	a := scram.Auth{User: user, Pass: auth.Password}
	return []sasl.Mechanism{
		a.AsSha512Mechanism(), a.AsSha256Mechanism(),
		plain.Auth{User: user, Pass: auth.Password}.AsMechanism(),
	}
}

func open(ctx context.Context, t integrations.Target, useTLS bool) (*client, error) {
	seeds := make([]string, 0, len(t.Members))
	for _, m := range t.Members {
		seeds = append(seeds, m.Address)
	}
	dial := dialer(t.Members, useTLS)
	opts := []kgo.Opt{
		kgo.SeedBrokers(seeds...),
		kgo.ClientID("watchlog"),
		kgo.Dialer(dial),
		kgo.RequestTimeoutOverhead(requestTime),
		kgo.RetryTimeout(requestTime),
		kgo.RequestRetries(1),
		kgo.MetadataMinAge(time.Second),
	}
	if m := mechanisms(t.Auth); m != nil {
		opts = append(opts, kgo.SASL(m...))
	}
	cl, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, err
	}
	c := &client{cl: cl, adm: kadm.NewClient(cl), dial: dial}
	c.adm.SetTimeoutMillis(int32(requestTime / time.Millisecond))
	// One request to know the listener answers (and the login works).
	pctx, cancel := context.WithTimeout(ctx, integrations.DialTimeout)
	defer cancel()
	if err := cl.Ping(pctx); err != nil {
		cl.Close()
		return nil, err
	}
	return c, nil
}

// Dial connects to the target's brokers: plaintext first, then TLS when the listener
// closed the plaintext connection.
func Dial(ctx context.Context, t integrations.Target) (Admin, error) {
	c, err := open(ctx, t, false)
	if err == nil {
		return c, nil
	}
	if !tlsWanted(err) {
		return nil, err
	}
	if c, terr := open(ctx, t, true); terr == nil {
		return c, nil
	}
	return nil, err
}

func tlsWanted(err error) bool {
	s := err.Error()
	return strings.Contains(s, "EOF") || strings.Contains(s, "connection reset") ||
		strings.Contains(s, "invalid large response size") || strings.Contains(s, "malformed")
}

// isAuth: the user or password was refused, or the broker wants a login.
func isAuth(err error) bool {
	s := err.Error()
	return strings.Contains(s, "SASL_AUTHENTICATION_FAILED") || strings.Contains(s, "ILLEGAL_SASL_STATE") ||
		strings.Contains(s, "UNSUPPORTED_SASL_MECHANISM")
}

// denied: an ACL refused the request.
func denied(err error) bool {
	return err != nil && strings.Contains(err.Error(), "AUTHORIZATION_FAILED")
}

func short(err error) string {
	s := strings.Join(strings.Fields(err.Error()), " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// ----------------------------------------------------------------- scraping

// Scrape implements integrations.Integration.
func (k *Kafka) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	if len(t.Members) == 0 {
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
		return res
	}
	// Each member's port, for the member rows and the connect time.
	for _, m := range t.Members {
		start := time.Now()
		ms := integrations.MemberStatus{Name: m.Name}
		conn, err := (&net.Dialer{Timeout: integrations.DialTimeout}).DialContext(ctx, "tcp", m.Address)
		if err == nil {
			_ = conn.Close()
			ms.Up = true
			res.Samples = append(res.Samples, metrics.New("watchlog_integration_connect_seconds", time.Since(start).Seconds(), "member", m.Name))
		} else {
			ms.Error = short(err)
		}
		res.Members = append(res.Members, ms)
	}
	a, err := k.Connect(ctx, t)
	if err != nil {
		res.State, res.Error = integrations.StateError, short(err)
		if isAuth(err) {
			res.ErrorCode = integrations.ProbeAuthFailed
		}
		return res
	}
	defer a.Close()
	s := &scrape{k: k, t: t, a: a, now: k.Now(), perms: map[string]string{}, extra: map[string]any{}}
	if err := s.light(ctx); err != nil {
		res.State, res.Error = integrations.StateError, short(err)
		return res
	}
	res.ServiceVersion = a.Version(ctx)
	k.mu.Lock()
	if heavy {
		k.mu.Unlock()
		hs := s.heavy(ctx)
		k.mu.Lock()
		k.heavy[t.ID] = hs
		res.Extra = s.extra
	}
	hs := k.heavy[t.ID]
	k.mu.Unlock()
	s.out = append(s.out, hs.samples...)
	for tab, missing := range hs.perms {
		if _, ok := s.perms[tab]; !ok {
			s.perms[tab] = missing
		}
	}
	s.out = append(s.out, k.readInternals(ctx, t, s.extra, heavy)...)
	res.Samples = append(res.Samples, s.out...)
	for tab, missing := range s.perms {
		res.Permissions = append(res.Permissions, integrations.Permission{Tab: tab, Missing: missing})
	}
	sort.Slice(res.Permissions, func(i, j int) bool { return res.Permissions[i].Tab < res.Permissions[j].Tab })
	return res
}

type scrape struct {
	k     *Kafka
	t     integrations.Target
	a     Admin
	now   time.Time
	out   []metrics.Sample
	perms map[string]string
	extra map[string]any
	meta  kadm.Metadata
	// topics kept (internal left out), by size or partitions.
	topics []string
}

func (s *scrape) add(name string, v float64, pairs ...string) {
	s.out = append(s.out, metrics.New(name, v, pairs...))
}

func id(n int32) string { return strconv.Itoa(int(n)) }

func joinIDs(ids []int32) string {
	parts := make([]string, len(ids))
	for i, n := range ids {
		parts[i] = id(n)
	}
	return strings.Join(parts, ",")
}

// light: brokers, partitions, end offsets per topic, groups and their lag.
func (s *scrape) light(ctx context.Context) error {
	rctx, cancel := context.WithTimeout(ctx, requestTime)
	m, err := s.a.Metadata(rctx)
	cancel()
	if err != nil {
		return err
	}
	s.meta = m
	live := map[int32]bool{}
	up := 0
	brokers := make([]map[string]any, 0, len(m.Brokers))
	for _, b := range m.Brokers {
		live[b.NodeID] = true
		ok := s.a.Reachable(ctx, b.Host, b.Port)
		v := 0.0
		if ok {
			v = 1
			up++
		}
		s.add("watchlog_kafka_broker_up", v, "broker", id(b.NodeID), "broker_host", b.Host)
		if b.NodeID == m.Controller {
			s.add("watchlog_kafka_controller", 1, "broker", id(b.NodeID))
		}
		rack := ""
		if b.Rack != nil {
			rack = *b.Rack
		}
		brokers = append(brokers, map[string]any{"id": b.NodeID, "host": b.Host, "port": b.Port, "rack": rack,
			"controller": b.NodeID == m.Controller, "up": ok})
	}
	s.extra["brokers"] = brokers
	s.add("watchlog_kafka_brokers", float64(len(m.Brokers)))
	s.add("watchlog_kafka_brokers_up", float64(up))

	replicas, leaders := map[int32]int{}, map[int32]int{}
	total, offline, under := 0, 0, 0
	var bad []map[string]any
	type topicStat struct{ partitions, rf, offline, under int }
	stats := map[string]*topicStat{}
	for _, t := range m.Topics.Sorted() {
		ts := &topicStat{}
		if !t.IsInternal && !strings.HasPrefix(t.Topic, "__") {
			stats[t.Topic] = ts
		}
		for _, p := range t.Partitions.Sorted() {
			total++
			ts.partitions++
			ts.rf = max(ts.rf, len(p.Replicas))
			for _, r := range p.Replicas {
				replicas[r]++
			}
			state := ""
			switch {
			case p.Leader < 0 || !live[p.Leader]:
				offline++
				ts.offline++
				state = "offline"
			case len(p.ISR) < len(p.Replicas):
				under++
				ts.under++
				state = "under_replicated"
			}
			if p.Leader >= 0 && live[p.Leader] {
				leaders[p.Leader]++
			}
			if state != "" && len(bad) < TopPartitions {
				bad = append(bad, map[string]any{"topic": t.Topic, "partition": p.Partition, "leader": p.Leader,
					"replicas": joinIDs(p.Replicas), "isr": joinIDs(p.ISR), "state": state})
			}
		}
	}
	for _, b := range m.Brokers {
		s.add("watchlog_kafka_broker_partitions", float64(replicas[b.NodeID]), "broker", id(b.NodeID))
		s.add("watchlog_kafka_broker_leaders", float64(leaders[b.NodeID]), "broker", id(b.NodeID))
	}
	s.add("watchlog_kafka_partitions", float64(total))
	s.add("watchlog_kafka_partitions_offline", float64(offline))
	s.add("watchlog_kafka_partitions_under_replicated", float64(under))
	s.add("watchlog_kafka_topics", float64(len(stats)))
	if bad == nil {
		bad = []map[string]any{}
	}
	s.extra["partitions"] = bad

	// The topics kept: by size when the heavy scrape knows it, else by partitions.
	sizes := s.k.sizes(s.t.ID)
	names := make([]string, 0, len(stats))
	for n := range stats {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := names[i], names[j]
		if sizes[a] != sizes[b] {
			return sizes[a] > sizes[b]
		}
		if stats[a].partitions != stats[b].partitions {
			return stats[a].partitions > stats[b].partitions
		}
		return a < b
	})
	if len(names) > TopTopics {
		names = names[:TopTopics]
	}
	s.topics = names
	for _, n := range names {
		st := stats[n]
		s.add("watchlog_kafka_topic_partitions", float64(st.partitions), "topic", n)
		s.add("watchlog_kafka_topic_replication_factor", float64(st.rf), "topic", n)
		s.add("watchlog_kafka_topic_offline_partitions", float64(st.offline), "topic", n)
		s.add("watchlog_kafka_topic_under_replicated_partitions", float64(st.under), "topic", n)
	}
	if len(names) > 0 {
		rctx, cancel := context.WithTimeout(ctx, requestTime)
		ends, err := s.a.ListEndOffsets(rctx, names...)
		cancel()
		if err != nil && denied(err) {
			s.perms["overview/rate"] = "Describe on every topic"
		}
		for _, n := range names {
			sum, ok := 0.0, false
			for _, o := range ends[n] {
				if o.Err == nil && o.Offset >= 0 {
					sum += float64(o.Offset)
					ok = true
				}
			}
			if ok {
				s.add("watchlog_kafka_topic_end_offset", sum, "topic", n)
			}
		}
	}
	s.groups(ctx)
	return nil
}

type groupRow struct {
	name, state string
	members     []member
	lag         map[string]int64 // topic → lag
	committed   map[string]int64 // topic → sum of committed offsets
	total       int64
}

// groups: ListGroups, then kadm's Lag (DescribeGroups, OffsetFetch, ListOffsets); the
// 100 lagging most are kept.
func (s *scrape) groups(ctx context.Context) {
	rctx, cancel := context.WithTimeout(ctx, requestTime)
	listed, err := s.a.ListGroups(rctx)
	cancel()
	if err != nil {
		if denied(err) {
			s.perms["consumer_groups/lag"] = "Describe on every group"
		}
		return
	}
	s.add("watchlog_kafka_groups", float64(len(listed)))
	if len(listed) == 0 {
		s.extra["groups"], s.extra["members"], s.extra["last_members"] = []map[string]any{}, []map[string]any{}, []map[string]any{}
		s.k.remember(s.t.ID, nil, s.now)
		return
	}
	rctx, cancel = context.WithTimeout(ctx, 2*requestTime)
	lags, err := s.a.Lag(rctx, listed.Groups()...)
	cancel()
	if err != nil {
		if denied(err) {
			s.perms["consumer_groups/lag"] = "Describe on every group"
		}
		return
	}
	rows := make([]*groupRow, 0, len(lags))
	for _, l := range lags {
		if l.DescribeErr != nil {
			if denied(l.DescribeErr) {
				s.perms["consumer_groups/lag"] = "Describe on every group"
			}
			continue
		}
		g := &groupRow{name: l.Group, state: l.State, lag: map[string]int64{}, committed: map[string]int64{}}
		// Partitions per member: from the lag rows (each names its member), else from the
		// assignment the group's leader sent.
		byMember := map[string]int{}
		for _, ps := range l.Lag {
			for _, p := range ps {
				if p.Member != nil {
					byMember[p.Member.MemberID]++
				}
			}
		}
		for _, mm := range l.Members {
			n := byMember[mm.MemberID]
			if c, ok := mm.Assigned.AsConsumer(); ok && n == 0 {
				for _, t := range c.Topics {
					n += len(t.Partitions)
				}
			}
			g.members = append(g.members, member{clientID: mm.ClientID, host: strings.TrimPrefix(mm.ClientHost, "/"), assigned: n})
		}
		for topic, ps := range l.Lag {
			for _, p := range ps {
				if p.Lag > 0 {
					g.lag[topic] += p.Lag
					g.total += p.Lag
				} else if _, ok := g.lag[topic]; !ok && p.Lag == 0 {
					g.lag[topic] = 0
				}
				if p.Commit.At >= 0 {
					g.committed[topic] += p.Commit.At
				}
			}
		}
		rows = append(rows, g)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].total != rows[j].total {
			return rows[i].total > rows[j].total
		}
		return rows[i].name < rows[j].name
	})
	if len(rows) > TopGroups {
		rows = rows[:TopGroups]
	}
	groupRows := make([]map[string]any, 0, len(rows))
	memberRows := []map[string]any{}
	for _, g := range rows {
		s.add("watchlog_kafka_group_members", float64(len(g.members)), "group", g.name)
		s.add("watchlog_kafka_group_state", 1, "group", g.name, "state", g.state)
		topics := make([]string, 0, len(g.lag))
		for t := range g.lag {
			topics = append(topics, t)
		}
		sort.Strings(topics)
		for _, t := range topics {
			s.add("watchlog_kafka_group_lag", float64(g.lag[t]), "group", g.name, "topic", t)
			if c, ok := g.committed[t]; ok {
				s.add("watchlog_kafka_group_committed_offset", float64(c), "group", g.name, "topic", t)
			}
		}
		groupRows = append(groupRows, map[string]any{"group": g.name, "state": g.state, "members": len(g.members),
			"topics": strings.Join(topics, ", "), "lag": g.total})
		for _, m := range g.members {
			if len(memberRows) >= TopMembers {
				break
			}
			memberRows = append(memberRows, map[string]any{"group": g.name, "client_id": m.clientID,
				"client_host": m.host, "assigned": m.assigned})
		}
	}
	s.extra["groups"] = groupRows
	s.extra["members"] = memberRows
	s.extra["last_members"] = s.k.remember(s.t.ID, rows, s.now)
}

// remember keeps each group's members while it has them, and once it is empty says who
// they were and when they left (the first scrape that saw it empty).
func (k *Kafka) remember(target string, rows []*groupRow, now time.Time) []map[string]any {
	k.mu.Lock()
	defer k.mu.Unlock()
	known := k.last[target]
	if known == nil {
		known = map[string]lastMembers{}
		k.last[target] = known
	}
	seen := map[string]bool{}
	for _, g := range rows {
		seen[g.name] = true
		prev := known[g.name]
		if len(g.members) > 0 {
			known[g.name] = lastMembers{members: g.members, seen: now}
			continue
		}
		if len(prev.members) == 0 {
			continue
		}
		if prev.leftAt.IsZero() {
			prev.leftAt = now
		}
		prev.seen = now
		known[g.name] = prev
	}
	out := []map[string]any{}
	for name, l := range known {
		if !seen[name] && now.Sub(l.seen) > Remember || !l.leftAt.IsZero() && now.Sub(l.leftAt) > Remember {
			delete(known, name)
			continue
		}
		if l.leftAt.IsZero() || !seen[name] {
			continue
		}
		for _, m := range l.members {
			out = append(out, map[string]any{"group": name, "client_id": m.clientID, "client_host": m.host,
				"left_at": l.leftAt.Unix()})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a["group"] != b["group"] {
			return a["group"].(string) < b["group"].(string)
		}
		return a["client_host"].(string) < b["client_host"].(string)
	})
	if len(out) > TopMembers {
		out = out[:TopMembers]
	}
	return out
}

// sizes: the last heavy scrape's topic sizes, to keep the largest topics.
func (k *Kafka) sizes(target string) map[string]float64 {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := map[string]float64{}
	for _, smp := range k.heavy[target].samples {
		if smp.Name == "watchlog_kafka_topic_size_bytes" {
			for _, l := range smp.Labels {
				if l.Name == "topic" {
					out[l.Value] = smp.Value
				}
			}
		}
	}
	return out
}

// heavy: log sizes per topic (leader replicas) and per broker, retention, the KRaft
// quorum. Its samples are repeated by the light scrapes until the next heavy one.
func (s *scrape) heavy(ctx context.Context) heavyState {
	hs := heavyState{perms: map[string]string{}}
	add := func(name string, v float64, pairs ...string) {
		hs.samples = append(hs.samples, metrics.New(name, v, pairs...))
	}
	leaders := map[string]map[int32]int32{}
	for _, t := range s.meta.Topics {
		leaders[t.Topic] = map[int32]int32{}
		for _, p := range t.Partitions {
			leaders[t.Topic][p.Partition] = p.Leader
		}
	}
	rctx, cancel := context.WithTimeout(ctx, requestTime)
	dirs, err := s.a.LogDirs(rctx)
	cancel()
	if err != nil && denied(err) {
		hs.perms["topics/largest"] = "Describe on the cluster"
	}
	kept := map[string]bool{}
	for _, n := range s.topics {
		kept[n] = true
	}
	topicSize := map[string]float64{}
	brokerSize := map[int32]float64{}
	dirs.Each(func(d kadm.DescribedLogDir) {
		if d.Err != nil {
			return
		}
		for topic, ps := range d.Topics {
			for _, p := range ps {
				brokerSize[d.Broker] += float64(p.Size)
				if leaders[topic][p.Partition] == d.Broker && !p.IsFuture {
					topicSize[topic] += float64(p.Size)
				}
			}
		}
	})
	if err == nil || len(brokerSize) > 0 {
		for b, v := range brokerSize {
			add("watchlog_kafka_broker_log_bytes", v, "broker", id(b))
		}
		// The largest topics, by size: the next light scrapes keep these.
		names := make([]string, 0, len(topicSize))
		for n := range topicSize {
			if kept[n] || len(kept) < TopTopics {
				if strings.HasPrefix(n, "__") {
					continue
				}
				names = append(names, n)
			}
		}
		sort.Slice(names, func(i, j int) bool { return topicSize[names[i]] > topicSize[names[j]] })
		if len(names) > TopTopics {
			names = names[:TopTopics]
		}
		for _, n := range names {
			add("watchlog_kafka_topic_size_bytes", topicSize[n], "topic", n)
		}
	}
	if len(s.topics) > 0 {
		rctx, cancel := context.WithTimeout(ctx, requestTime)
		cfgs, err := s.a.TopicConfigs(rctx, s.topics...)
		cancel()
		if denied(err) {
			hs.perms["topics/topics"] = "DescribeConfigs on every topic"
		}
		for _, rc := range cfgs {
			if rc.Err != nil {
				if denied(rc.Err) {
					hs.perms["topics/topics"] = "DescribeConfigs on every topic"
				}
				continue
			}
			for _, c := range rc.Configs {
				v, err := strconv.ParseFloat(c.MaybeValue(), 64)
				if err != nil {
					continue
				}
				switch c.Key {
				case "retention.ms":
					if v >= 0 {
						v /= 1000
					}
					add("watchlog_kafka_topic_retention_seconds", v, "topic", rc.Name)
				case "retention.bytes":
					add("watchlog_kafka_topic_retention_bytes", v, "topic", rc.Name)
				}
			}
		}
	}
	rctx, cancel = context.WithTimeout(ctx, requestTime)
	q, err := s.a.Quorum(rctx)
	cancel()
	switch {
	case err != nil && denied(err):
		hs.perms["brokers/brokers"] = "Describe on the cluster"
	case err == nil && q != nil && q.ErrorCode == 0 && len(q.Topics) > 0 && len(q.Topics[0].Partitions) > 0:
		p := q.Topics[0].Partitions[0]
		if p.ErrorCode == 0 {
			s.extra["quorum"] = []map[string]any{{"leader": p.LeaderID, "voters": len(p.CurrentVoters), "observers": len(p.Observers)}}
		}
	case err == nil && q != nil && q.ErrorCode == 29:
		hs.perms["brokers/brokers"] = "Describe on the cluster"
	}
	return hs
}

// ----------------------------------------------------------------- broker internals

var internalFamilies = []struct {
	re   *regexp.Regexp
	name string
}{
	{regexp.MustCompile(`^kafka_server_brokertopicmetrics_bytesin(persec)?(_total|_count)$`), "watchlog_kafka_internal_bytes_in_total"},
	{regexp.MustCompile(`^kafka_server_brokertopicmetrics_bytesout(persec)?(_total|_count)$`), "watchlog_kafka_internal_bytes_out_total"},
	{regexp.MustCompile(`^kafka_server_brokertopicmetrics_messagesin(persec)?(_total|_count)$`), "watchlog_kafka_internal_messages_in_total"},
	{regexp.MustCompile(`^kafka_network_requestmetrics_requests(persec)?(_total|_count)$`), "watchlog_kafka_internal_requests_total"},
}

// Internals turns a JMX exporter's page into WatchLog's traffic counters for one member:
// bytes and messages summed over topics (each topic's own rows and the all-topics row
// are told apart by the `topic` label), requests per request type.
func Internals(r io.Reader, memberName string) ([]metrics.Sample, error) {
	keep := func(name string) bool {
		for _, f := range internalFamilies {
			if f.re.MatchString(name) {
				return true
			}
		}
		return false
	}
	samples, err := promtext.Parse(io.LimitReader(r, MaxBody), keep)
	if err != nil {
		return nil, err
	}
	type key struct{ name, request string }
	all, perTopic := map[key]float64{}, map[key]float64{}
	hasAll := map[key]bool{}
	for _, smp := range samples {
		for _, f := range internalFamilies {
			if !f.re.MatchString(smp.Name) {
				continue
			}
			k := key{name: f.name}
			if f.name == "watchlog_kafka_internal_requests_total" {
				k.request = smp.Labels["request"]
				if k.request == "" {
					continue
				}
				// Strimzi splits by API version: summed.
				all[k] += smp.Value
				hasAll[k] = true
				continue
			}
			if smp.Labels["topic"] == "" {
				all[k] += smp.Value
				hasAll[k] = true
			} else {
				perTopic[k] += smp.Value
			}
		}
	}
	var out []metrics.Sample
	for k, v := range perTopic {
		if !hasAll[k] {
			all[k] = v
		}
	}
	for k, v := range all {
		if k.request != "" {
			out = append(out, metrics.New(k.name, v, "member", memberName, "request", k.request))
		} else {
			out = append(out, metrics.New(k.name, v, "member", memberName))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// readInternals reads each member's Prometheus endpoint where one was found; the ports
// are tried again every 10 minutes where none answered.
func (k *Kafka) readInternals(ctx context.Context, t integrations.Target, extra map[string]any, heavy bool) []metrics.Sample {
	var out []metrics.Sample
	var rows []map[string]any
	for _, m := range t.Members {
		host, _, err := net.SplitHostPort(m.Address)
		if err != nil {
			continue
		}
		key := t.ID + "/" + m.Name
		k.mu.Lock()
		st, known := k.internals[key]
		k.mu.Unlock()
		if !known || st.url == "" && k.Now().Sub(st.triedAt) > InternalsRecheck {
			st = internalsState{triedAt: k.Now()}
			for _, p := range k.Ports {
				u := "http://" + net.JoinHostPort(host, p) + "/metrics"
				if smp, err := k.fetch(ctx, u, m.Name); err == nil && len(smp) > 0 {
					st.url = u
					break
				}
			}
			k.mu.Lock()
			k.internals[key] = st
			k.mu.Unlock()
		}
		if st.url == "" {
			continue
		}
		smp, err := k.fetch(ctx, st.url, m.Name)
		if err != nil {
			continue
		}
		out = append(out, smp...)
		rows = append(rows, map[string]any{"member": m.Name, "url": st.url})
	}
	if heavy && rows != nil {
		extra["internals"] = rows
	}
	return out
}

func (k *Kafka) fetch(ctx context.Context, u, memberName string) ([]metrics.Sample, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := k.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", u, res.StatusCode)
	}
	return Internals(res.Body, memberName)
}

// ----------------------------------------------------------------- probe

// Probe implements integrations.Prober: connect (and log in), then try the reads
// WatchLog needs; a refused one names the ACL it needs.
func (k *Kafka) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	if len(t.Members) == 0 {
		return integrations.ProbeResult{Code: integrations.ProbeUnreachable, Error: "no member to connect to"}
	}
	a, err := k.Connect(ctx, t)
	if err != nil {
		code := integrations.ProbeUnreachable
		if isAuth(err) {
			code = integrations.ProbeAuthFailed
		}
		return integrations.ProbeResult{Code: code, Error: short(err)}
	}
	defer a.Close()
	m, err := a.Metadata(ctx)
	if err != nil {
		if denied(err) {
			return integrations.ProbeResult{Code: integrations.ProbePermission, Missing: []string{"Describe on every topic"}, Error: short(err)}
		}
		return integrations.ProbeResult{Code: integrations.ProbeError, Error: short(err)}
	}
	out := integrations.ProbeResult{Code: integrations.ProbeOK, Version: a.Version(ctx), Facts: map[string]any{
		"brokers": len(m.Brokers),
	}}
	topics := 0
	for _, t := range m.Topics {
		if !t.IsInternal && !strings.HasPrefix(t.Topic, "__") {
			topics++
		}
	}
	out.Facts["topics"] = topics
	var missing []string
	if g, err := a.ListGroups(ctx); err != nil {
		if denied(err) {
			missing = append(missing, "Describe on every group")
		}
	} else {
		out.Facts["groups"] = len(g)
		if lags, err := a.Lag(ctx, g.Groups()...); err == nil {
			for _, l := range lags {
				if denied(l.DescribeErr) || denied(l.FetchErr) {
					missing = append(missing, "Describe on every group")
					break
				}
			}
		} else if denied(err) {
			missing = append(missing, "Describe on every group")
		}
	}
	if _, err := a.LogDirs(ctx); denied(err) {
		missing = append(missing, "Describe on the cluster")
	}
	if t.Auth == nil || t.Auth.Password == "" {
		out.Facts["auth"] = "off"
	}
	if len(missing) > 0 {
		out.Code, out.Missing = integrations.ProbePermission, dedupe(missing)
	}
	return out
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// String keeps the type readable in logs.
func (k *Kafka) String() string { return "kafka" }
