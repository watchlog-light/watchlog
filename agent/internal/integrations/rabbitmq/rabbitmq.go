// SPDX-License-Identifier: AGPL-3.0-only

// Package rabbitmq is the RabbitMQ integration (SPEC §4.12, v0.3 slice 11): the
// rabbitmq_prometheus plugin's endpoint on :15692 of every node, read as it is.
// `/metrics` gives each node's totals every scrape; the heavy scrape adds the per-queue
// families of `/metrics/detailed` (depth, consumers, publish and deliver counters), the
// 200 deepest queues. No user, no management API. When the plugin is off the status
// says so, and the page gives the command that enables it (no restart).
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

// Families of /metrics/detailed read by the heavy scrape.
const detailed = "/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count" +
	"&family=queue_delivery_metrics&family=queue_exchange_metrics"

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
}

// RabbitMQ is the integration; it keeps each target's last per-queue series, which the
// light scrapes in between repeat so a queue's lines don't come and go.
type RabbitMQ struct {
	mu     sync.Mutex
	queues map[string][]metrics.Sample // by target id and member
	Client *http.Client
	// Port is replaced in tests.
	Port string
}

// New returns the integration.
func New() *RabbitMQ {
	return &RabbitMQ{
		queues: map[string][]metrics.Sample{},
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
	key := id + "\x00" + m.Name
	if heavy {
		q, err := r.read(ctx, base+detailed, func(n string) bool { return queue[n] })
		if err == nil {
			r.mu.Lock()
			r.queues[key] = queueSamples(q)
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
	// The exchange label is summed away: a queue's published total from every exchange.
	type sk struct {
		name string
		q    qk
	}
	sums := map[sk]float64{}
	var order []sk
	for _, s := range in {
		k := qk{s.Labels["vhost"], s.Labels["queue"]}
		if !kept[k] {
			continue
		}
		// The plugin's own names: the node totals keep theirs, without a queue label.
		key := sk{s.Name, k}
		if _, seen := sums[key]; !seen {
			order = append(order, key)
		}
		sums[key] += s.Value
	}
	out := make([]metrics.Sample, 0, len(order))
	for _, k := range order {
		out = append(out, metrics.New(k.name, sums[k], "vhost", k.q.vhost, "queue", k.q.queue))
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
