// SPDX-License-Identifier: AGPL-3.0-only

// Package rabbitmq is the RabbitMQ integration (SPEC §4.12, v0.3 slice 11): the
// rabbitmq_prometheus plugin's endpoint on :15692 of every node, read as it is.
// `/metrics` gives each node's totals every scrape; the heavy scrape adds the per-queue
// families of `/metrics/detailed` (depth, consumers, publish and deliver counters), the
// 200 deepest queues. No user, no management API. When the plugin is off the status
// says so, and the page gives the command that enables it (no restart).
//
// 1.1.0 (ADR-243): each queue's type (4.x labels it; on 3.13 a queue with Raft series is
// quorum, one with stream segments a stream), its consumer utilisation and bytes on disk,
// its Raft term and commit latency, the exchanges with their type and per-exchange publish
// and unroutable counters, and each node's version, uptime and sockets. 3.13 keeps the
// per-queue and per-exchange counters per channel only: they are summed here, kept
// monotonic when a channel closes, and sent under 4.x's names.
package rabbitmq

import (
	"context"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/integrations/promtext"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

const (
	// MetricsPort is rabbitmq_prometheus's port.
	MetricsPort = "15692"
	// TopQueues caps the per-queue series per node (ADR-136).
	TopQueues = 200
	// MaxBody bounds one response read.
	MaxBody = 16 << 20
)

// Families of /metrics/detailed read by the heavy scrape: queues, exchanges and Raft.
const detailed = "/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count" +
	"&family=queue_delivery_metrics&family=queue_exchange_metrics" +
	"&family=exchange_names&family=exchange_metrics&family=ra_metrics"

// queue_metrics on its own request: about 25 series a queue, so a broker with very many
// queues can pass MaxBody there without losing the counters above.
const queueMetrics = "/metrics/detailed?family=queue_metrics"

// 3.13's per-channel counters, read only where queue_delivery_metrics is empty.
const channelFamilies = "/metrics/detailed?family=channel_queue_metrics" +
	"&family=channel_queue_exchange_metrics&family=channel_exchange_metrics"

// TopExchanges caps the per-exchange series per node.
const TopExchanges = 100

// node are the /metrics families kept: each node's totals, unlabelled.
var node = map[string]bool{
	"rabbitmq_queue_messages_ready":                               true,
	"rabbitmq_queue_messages_unacked":                             true,
	"rabbitmq_queues":                                             true,
	"rabbitmq_connections":                                        true,
	"rabbitmq_channels":                                           true,
	"rabbitmq_consumers":                                          true,
	"rabbitmq_global_publishers":                                  true,
	"rabbitmq_global_consumers":                                   true,
	"rabbitmq_global_messages_received_total":                     true,
	"rabbitmq_global_messages_routed_total":                       true,
	"rabbitmq_global_messages_delivered_total":                    true,
	"rabbitmq_global_messages_redelivered_total":                  true,
	"rabbitmq_global_messages_acknowledged_total":                 true,
	"rabbitmq_global_messages_confirmed_total":                    true,
	"rabbitmq_global_messages_unroutable_dropped_total":           true,
	"rabbitmq_global_messages_unroutable_returned_total":          true,
	"rabbitmq_global_messages_dead_lettered_expired_total":        true,
	"rabbitmq_global_messages_dead_lettered_rejected_total":       true,
	"rabbitmq_global_messages_dead_lettered_maxlen_total":         true,
	"rabbitmq_global_messages_dead_lettered_delivery_limit_total": true,
	"rabbitmq_connections_opened_total":                           true,
	"rabbitmq_connections_closed_total":                           true,
	"rabbitmq_channels_opened_total":                              true,
	"rabbitmq_channels_closed_total":                              true,
	"rabbitmq_erlang_uptime_seconds":                              true,
	"rabbitmq_process_open_tcp_sockets":                           true,
	"rabbitmq_process_max_tcp_sockets":                            true,
	"rabbitmq_process_resident_memory_bytes":                      true,
	"rabbitmq_resident_memory_limit_bytes":                        true,
	"rabbitmq_disk_space_available_bytes":                         true,
	"rabbitmq_disk_space_available_limit_bytes":                   true,
	"rabbitmq_process_open_fds":                                   true,
	"rabbitmq_process_max_fds":                                    true,
	"rabbitmq_erlang_processes_used":                              true,
	"rabbitmq_erlang_processes_limit":                             true,
	"rabbitmq_alarms_memory_used_watermark":                       true,
	"rabbitmq_alarms_free_disk_space_watermark":                   true,
	"rabbitmq_alarms_file_descriptor_limit":                       true,
	"rabbitmq_build_info":                                         true,
	"rabbitmq_identity_info":                                      true,
}

// queue are the per-queue families kept (vhost and queue; the exchange summed away).
var queue = map[string]bool{
	"rabbitmq_detailed_queue_messages_ready":                    true,
	"rabbitmq_detailed_queue_messages_unacked":                  true,
	"rabbitmq_detailed_queue_consumers":                         true,
	"rabbitmq_detailed_queue_consumer_utilisation":              true,
	"rabbitmq_detailed_queue_messages_delivered_ack_total":      true,
	"rabbitmq_detailed_queue_messages_delivered_total":          true,
	"rabbitmq_detailed_queue_messages_acked_total":              true,
	"rabbitmq_detailed_queue_messages_redelivered_total":        true,
	"rabbitmq_detailed_queue_exchange_messages_published_total": true,
	// Raft, per quorum queue (ra_metrics): elections and commit latency.
	"rabbitmq_detailed_raft_term_total":                   true,
	"rabbitmq_detailed_raft_entry_commit_latency_seconds": true,
	// queue_metrics: the type (4.x), stream segments, bytes on disk.
	"rabbitmq_detailed_queue_info":                      true,
	"rabbitmq_detailed_stream_segments":                 true,
	"rabbitmq_detailed_queue_messages_persistent_bytes": true,
}

// exchange are the exchange families kept (vhost and exchange; the type on the name).
var exchange = map[string]bool{
	"rabbitmq_cluster_exchange_name":                                true,
	"rabbitmq_detailed_exchange_messages_published_total":           true,
	"rabbitmq_detailed_exchange_messages_unroutable_dropped_total":  true,
	"rabbitmq_detailed_exchange_messages_unroutable_returned_total": true,
}

// channelAs maps 3.13's per-channel families to the 4.x per-queue and per-exchange names.
var channelAs = map[string]string{
	"rabbitmq_detailed_channel_messages_acked_total":               "rabbitmq_detailed_queue_messages_acked_total",
	"rabbitmq_detailed_channel_messages_redelivered_total":         "rabbitmq_detailed_queue_messages_redelivered_total",
	"rabbitmq_detailed_channel_messages_delivered_ack_total":       "rabbitmq_detailed_queue_messages_delivered_ack_total",
	"rabbitmq_detailed_channel_messages_delivered_total":           "rabbitmq_detailed_queue_messages_delivered_total",
	"rabbitmq_detailed_queue_messages_published_total":             "rabbitmq_detailed_queue_exchange_messages_published_total",
	"rabbitmq_detailed_channel_messages_published_total":           "rabbitmq_detailed_exchange_messages_published_total",
	"rabbitmq_detailed_channel_messages_unroutable_dropped_total":  "rabbitmq_detailed_exchange_messages_unroutable_dropped_total",
	"rabbitmq_detailed_channel_messages_unroutable_returned_total": "rabbitmq_detailed_exchange_messages_unroutable_returned_total",
}

// RabbitMQ is the integration; it keeps each target's last per-queue series, which the
// light scrapes in between repeat so a queue's lines don't come and go.
type RabbitMQ struct {
	mu     sync.Mutex
	queues map[string][]metrics.Sample // by target id and member
	folds  map[string]*fold            // 3.13's per-channel sums, by target id and member
	Client *http.Client
	// Port is replaced in tests.
	Port string
}

// New returns the integration.
func New() *RabbitMQ {
	return &RabbitMQ{
		queues: map[string][]metrics.Sample{},
		folds:  map[string]*fold{},
		Client: &http.Client{
			Timeout:       integrations.DialTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		Port: MetricsPort,
	}
}

// Scrape implements integrations.Integration.
func (r *RabbitMQ) Scrape(ctx context.Context, t integrations.Target, heavy bool) integrations.Result {
	res := integrations.Result{State: integrations.StateOK}
	up, pluginOff := 0, 0
	var nodes []map[string]any
	for _, m := range t.Members {
		out := r.member(ctx, t.ID, m, heavy)
		res.Members = append(res.Members, out.status)
		if !out.status.Up {
			continue
		}
		up++
		if !out.plugin {
			pluginOff++
		}
		res.Samples = append(res.Samples, out.samples...)
		if res.ServiceVersion == "" {
			res.ServiceVersion = out.version
		}
		nodes = append(nodes, map[string]any{"member": m.Name, "node": out.node, "cluster": out.cluster, "plugin": out.plugin})
	}
	if up > 0 {
		res.Extra = map[string]any{"rabbitmq": nodes}
	}
	res.Facts = map[string]any{"plugin_off": pluginOff}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = integrations.StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State, res.Error = integrations.StateError, res.Members[0].Error
	}
	return res
}

// Probe implements integrations.Prober: RabbitMQ needs no user here; the test is that a
// node answers on AMQP, and whether its metrics plugin is on.
func (r *RabbitMQ) Probe(ctx context.Context, t integrations.Target) integrations.ProbeResult {
	res := r.Scrape(ctx, t, false)
	out := integrations.ProbeResult{Code: integrations.ProbeOK, Version: res.ServiceVersion, Facts: res.Facts}
	if res.State != integrations.StateOK {
		out.Code, out.Error = integrations.ProbeUnreachable, res.Error
	}
	return out
}

type memberOut struct {
	status        integrations.MemberStatus
	samples       []metrics.Sample
	plugin        bool
	version       string
	node, cluster string
}

func (r *RabbitMQ) member(ctx context.Context, id string, m integrations.Member, heavy bool) memberOut {
	out := memberOut{status: integrations.MemberStatus{Name: m.Name}}
	host, _, err := net.SplitHostPort(m.Address)
	if err != nil {
		out.status.Error = "bad address " + m.Address
		return out
	}
	start := time.Now()
	d := net.Dialer{Timeout: integrations.DialTimeout}
	conn, err := d.DialContext(ctx, "tcp", m.Address)
	if err != nil {
		out.status.Error = shortError(err)
		return out
	}
	_ = conn.Close()
	out.status.Up = true
	label := metrics.Label{Name: "member", Value: m.Name}
	out.samples = append(out.samples, metrics.New("watchlog_integration_connect_seconds", time.Since(start).Seconds()).WithLabels(label))

	base := "http://" + net.JoinHostPort(host, r.Port)
	parsed, err := r.read(ctx, base+"/metrics", func(n string) bool { return node[n] })
	if err != nil {
		return out // the plugin is off (or its port closed): the page says how to enable it
	}
	out.plugin = true
	// The node's totals, one series each: RabbitMQ splits some (the global message
	// counters by protocol and queue type), and those labels are summed away. Sending
	// the parts as one series made its value jump between them, and rate() read every
	// drop as a counter reset (the demo showed hundreds of publishes a second for 3).
	totals := map[string]float64{}
	var order []string
	for _, p := range parsed {
		switch p.Name {
		case "rabbitmq_build_info":
			out.version = p.Labels["rabbitmq_version"]
			continue
		case "rabbitmq_identity_info":
			out.node, out.cluster = p.Labels["rabbitmq_node"], p.Labels["rabbitmq_cluster"]
			continue
		}
		if _, seen := totals[p.Name]; !seen {
			order = append(order, p.Name)
		}
		totals[p.Name] += p.Value
	}
	for _, name := range order {
		out.samples = append(out.samples, metrics.New(name, totals[name]).WithLabels(label))
	}
	// The node's version and Erlang name (1.1.0): "same version on every node".
	if out.version != "" || out.node != "" {
		out.samples = append(out.samples, metrics.New("watchlog_rabbitmq_node_info", 1,
			"version", out.version, "rabbitmq_node", out.node).WithLabels(label))
	}
	key := id + "\x00" + m.Name
	if heavy {
		if q, err := r.heavy(ctx, base, key); err == nil {
			r.mu.Lock()
			r.queues[key] = q
			r.mu.Unlock()
		}
	}
	r.mu.Lock()
	for _, s := range r.queues[key] {
		out.samples = append(out.samples, s.WithLabels(label))
	}
	r.mu.Unlock()
	return out
}

// heavy reads the per-queue and per-exchange families: 4.x's own, or 3.13's per-channel
// counters summed (when queue_delivery_metrics is empty there).
func (r *RabbitMQ) heavy(ctx context.Context, base, key string) ([]metrics.Sample, error) {
	all, err := r.read(ctx, base+detailed, func(n string) bool { return queue[n] || exchange[n] })
	if err != nil {
		return nil, err
	}
	if qm, err := r.read(ctx, base+queueMetrics, func(n string) bool { return queue[n] }); err == nil {
		all = append(all, qm...)
	}
	if !hasDelivery(all) {
		ch, err := r.read(ctx, base+channelFamilies, func(n string) bool { return channelAs[n] != "" })
		if err == nil {
			r.mu.Lock()
			f := r.folds[key]
			if f == nil {
				f = &fold{last: map[string]float64{}, carried: map[string]float64{}}
				r.folds[key] = f
			}
			all = append(all, f.add(ch)...)
			r.mu.Unlock()
		}
	}
	return append(queueSamples(all), exchangeSamples(all)...), nil
}

// hasDelivery: the node fills queue_delivery_metrics (4.x); 3.13 leaves it empty.
func hasDelivery(in []promtext.Sample) bool {
	for _, s := range in {
		switch s.Name {
		case "rabbitmq_detailed_queue_messages_acked_total",
			"rabbitmq_detailed_queue_messages_delivered_ack_total",
			"rabbitmq_detailed_queue_messages_delivered_total":
			return true
		}
	}
	return false
}

// fold sums 3.13's per-channel counters per queue or exchange, monotonic: a channel that
// closes leaves its last count behind (carried), so a total never drops and rate() never
// reads a closed channel as a reset.
type fold struct {
	last    map[string]float64 // by output key and channel
	carried map[string]float64 // by output key
}

func (f *fold) add(in []promtext.Sample) []promtext.Sample {
	type out struct {
		name   string
		labels map[string]string
	}
	now := map[string]float64{}
	keys := map[string]out{}
	var order []string
	for _, s := range in {
		name := channelAs[s.Name]
		if name == "" {
			continue
		}
		var labels map[string]string
		switch {
		case s.Name == "rabbitmq_detailed_queue_messages_published_total":
			labels = map[string]string{"vhost": s.Labels["queue_vhost"], "queue": s.Labels["queue"], "exchange": s.Labels["exchange"]}
		case strings.HasPrefix(name, "rabbitmq_detailed_exchange_"):
			labels = map[string]string{"vhost": s.Labels["vhost"], "exchange": s.Labels["exchange"]}
		default:
			labels = map[string]string{"vhost": s.Labels["vhost"], "queue": s.Labels["queue"]}
		}
		k := name + "\x00" + labels["vhost"] + "\x00" + labels["queue"] + "\x00" + labels["exchange"]
		if _, seen := keys[k]; !seen {
			keys[k] = out{name, labels}
			order = append(order, k)
		}
		now[k+"\x00"+s.Labels["channel"]] += s.Value
	}
	// What the channels gone since the last read (or reset) had counted.
	for ck, v := range f.last {
		k := ck[:strings.LastIndex(ck, "\x00")]
		if cur, ok := now[ck]; !ok || cur < v {
			f.carried[k] += v
			if _, seen := keys[k]; !seen {
				o := strings.Split(k, "\x00")
				labels := map[string]string{"vhost": o[1]}
				if o[2] != "" {
					labels["queue"] = o[2]
				}
				if o[3] != "" {
					labels["exchange"] = o[3]
				}
				keys[k] = out{o[0], labels}
				order = append(order, k)
			}
		}
	}
	f.last = now
	totals := map[string]float64{}
	for k, v := range f.carried {
		totals[k] = v
	}
	for ck, v := range now {
		totals[ck[:strings.LastIndex(ck, "\x00")]] += v
	}
	res := make([]promtext.Sample, 0, len(order))
	for _, k := range order {
		o := keys[k]
		res = append(res, promtext.Sample{Name: o.name, Labels: o.labels, Value: totals[k]})
	}
	return res
}

func (r *RabbitMQ) read(ctx context.Context, url string, keep func(string) bool) ([]promtext.Sample, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "watchlog-integrations")
	res, err := r.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, errStatus
	}
	return promtext.Parse(io.LimitReader(res.Body, MaxBody), keep)
}

type statusErr struct{}

func (statusErr) Error() string { return "not the metrics endpoint" }

var errStatus = statusErr{}

// queueSamples keeps the TopQueues deepest queues (ready + unacked), and every queue
// with messages and no consumer, whatever its depth: those are the ones that matter.
func queueSamples(in []promtext.Sample) []metrics.Sample {
	type qk struct{ vhost, queue string }
	depth := map[qk]float64{}
	idle := map[qk]bool{}
	for _, s := range in {
		k := qk{s.Labels["vhost"], s.Labels["queue"]}
		switch s.Name {
		case "rabbitmq_detailed_queue_messages_ready", "rabbitmq_detailed_queue_messages_unacked":
			depth[k] += s.Value
		case "rabbitmq_detailed_queue_consumers":
			if _, ok := depth[k]; !ok {
				depth[k] = 0
			}
			if s.Value == 0 {
				idle[k] = true
			}
		}
	}
	keys := make([]qk, 0, len(depth))
	for k := range depth {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if depth[keys[i]] != depth[keys[j]] {
			return depth[keys[i]] > depth[keys[j]]
		}
		return keys[i].vhost+keys[i].queue < keys[j].vhost+keys[j].queue
	})
	kept := map[qk]bool{}
	for i, k := range keys {
		if i < TopQueues || (idle[k] && depth[k] > 0) {
			kept[k] = true
		}
	}
	// Each kept queue's type: 4.x labels it (queue_info); on 3.13 a queue with Raft series
	// is a quorum queue, one with stream segments a stream, the rest classic.
	types := map[qk]string{}
	member := map[qk]string{}
	for _, s := range in {
		k := qk{s.Labels["vhost"], s.Labels["queue"]}
		if !kept[k] {
			continue
		}
		switch s.Name {
		case "rabbitmq_detailed_queue_info":
			types[k] = queueType(s.Labels["queue_type"])
			member[k] = s.Labels["membership"]
		case "rabbitmq_detailed_raft_term_total":
			if types[k] == "" {
				types[k] = "quorum"
			}
		case "rabbitmq_detailed_stream_segments":
			if types[k] == "" || types[k] == "quorum" {
				types[k] = "stream"
			}
		}
	}
	// The exchange label is summed away: a queue's published total from every exchange.
	type sk struct {
		name string
		q    qk
	}
	sums := map[sk]float64{}
	var order []sk
	for _, s := range in {
		k := qk{s.Labels["vhost"], s.Labels["queue"]}
		if !kept[k] || !queue[s.Name] || s.Name == "rabbitmq_detailed_queue_info" {
			continue
		}
		// The plugin's own names: the node totals keep theirs, without a queue label.
		key := sk{s.Name, k}
		if _, seen := sums[key]; !seen {
			order = append(order, key)
		}
		sums[key] += s.Value
	}
	out := make([]metrics.Sample, 0, len(order)+len(kept))
	for _, k := range order {
		out = append(out, metrics.New(k.name, sums[k], "vhost", k.q.vhost, "queue", k.q.queue))
	}
	for _, k := range keys {
		if !kept[k] {
			continue
		}
		t := types[k]
		if t == "" {
			t = "classic"
		}
		labels := []string{"vhost", k.vhost, "queue", k.queue, "type", t}
		if member[k] != "" {
			labels = append(labels, "membership", member[k])
		}
		out = append(out, metrics.New("rabbitmq_detailed_queue_info", 1, labels...))
	}
	return out
}

// queueType: "rabbit_quorum_queue" → "quorum".
func queueType(v string) string {
	v = strings.TrimSuffix(strings.TrimPrefix(v, "rabbit_"), "_queue")
	switch v {
	case "classic", "quorum", "stream":
		return v
	case "":
		return ""
	}
	return v
}

// exchangeSamples keeps the TopExchanges busiest exchanges' counters, and every
// exchange's name with its type (the default exchange "" too).
func exchangeSamples(in []promtext.Sample) []metrics.Sample {
	type ek struct{ vhost, exchange string }
	published := map[ek]float64{}
	for _, s := range in {
		if s.Name == "rabbitmq_detailed_exchange_messages_published_total" {
			published[ek{s.Labels["vhost"], s.Labels["exchange"]}] += s.Value
		}
	}
	busy := make([]ek, 0, len(published))
	for k := range published {
		busy = append(busy, k)
	}
	sort.Slice(busy, func(i, j int) bool {
		if published[busy[i]] != published[busy[j]] {
			return published[busy[i]] > published[busy[j]]
		}
		return busy[i].vhost+busy[i].exchange < busy[j].vhost+busy[j].exchange
	})
	kept := map[ek]bool{}
	for i, k := range busy {
		if i < TopExchanges {
			kept[k] = true
		}
	}
	var out []metrics.Sample
	names := 0
	for _, s := range in {
		k := ek{s.Labels["vhost"], s.Labels["exchange"]}
		switch {
		case s.Name == "rabbitmq_cluster_exchange_name":
			if names >= 3*TopExchanges {
				continue
			}
			names++
			out = append(out, metrics.New(s.Name, 1, "vhost", k.vhost, "exchange", k.exchange, "type", s.Labels["type"]))
		case exchange[s.Name] && kept[k]:
			out = append(out, metrics.New(s.Name, s.Value, "vhost", k.vhost, "exchange", k.exchange))
		}
	}
	return out
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
