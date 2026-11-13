// SPDX-License-Identifier: AGPL-3.0-only

package kafka

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kmsg"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// fake answers as apache/kafka-native 4.1.1 did on the e2e VM (single KRaft node,
// Compose, advertised kafka:9092), recorded with kadm and reshaped here: kfake is a
// separate module, so the admin client sits behind an interface instead (ADR-166).
type fake struct {
	meta      kadm.Metadata
	ends      kadm.ListedOffsets
	groups    kadm.ListedGroups
	lags      kadm.DescribedGroupLags
	dirs      kadm.DescribedAllLogDirs
	cfgs      kadm.ResourceConfigs
	groupsErr error
	dirsErr   error
	down      map[string]bool
}

func (f *fake) Metadata(context.Context) (kadm.Metadata, error) { return f.meta, nil }
func (f *fake) ListEndOffsets(context.Context, ...string) (kadm.ListedOffsets, error) {
	return f.ends, nil
}
func (f *fake) ListGroups(context.Context) (kadm.ListedGroups, error) {
	return f.groups, f.groupsErr
}
func (f *fake) Lag(context.Context, ...string) (kadm.DescribedGroupLags, error) { return f.lags, nil }
func (f *fake) LogDirs(context.Context) (kadm.DescribedAllLogDirs, error)       { return f.dirs, f.dirsErr }
func (f *fake) TopicConfigs(context.Context, ...string) (kadm.ResourceConfigs, error) {
	return f.cfgs, nil
}
func (f *fake) Quorum(context.Context) (*kmsg.DescribeQuorumResponse, error) {
	r := kmsg.NewPtrDescribeQuorumResponse()
	t := kmsg.NewDescribeQuorumResponseTopic()
	p := kmsg.NewDescribeQuorumResponseTopicPartition()
	p.LeaderID = 1
	p.CurrentVoters = []kmsg.DescribeQuorumResponseTopicPartitionReplicaState{{ReplicaID: 1}}
	t.Partitions = append(t.Partitions, p)
	r.Topics = append(r.Topics, t)
	return r, nil
}
func (f *fake) Version(context.Context) string { return "4.1" }
func (f *fake) Reachable(_ context.Context, host string, _ int32) bool {
	return !f.down[host]
}
func (f *fake) Close() {}

func str(s string) *string { return &s }

func recorded(members int) *fake {
	parts := func(topic string, n int, rf []int32, isr []int32, leader int32) kadm.PartitionDetails {
		out := kadm.PartitionDetails{}
		for i := range n {
			out[int32(i)] = kadm.PartitionDetail{Topic: topic, Partition: int32(i), Leader: leader, Replicas: rf, ISR: isr}
		}
		return out
	}
	f := &fake{
		meta: kadm.Metadata{
			Controller: 1,
			Brokers:    kadm.BrokerDetails{{NodeID: 1, Host: "kafka", Port: 9092}, {NodeID: 2, Host: "kafka-2", Port: 9092, Rack: str("a")}},
			Topics: kadm.TopicDetails{
				"__consumer_offsets": {Topic: "__consumer_offsets", IsInternal: true, Partitions: parts("__consumer_offsets", 50, []int32{1}, []int32{1}, 1)},
				"orders":             {Topic: "orders", Partitions: parts("orders", 3, []int32{1, 2}, []int32{1}, 1)},
				"ledger":             {Topic: "ledger", Partitions: parts("ledger", 2, []int32{3}, []int32{}, -1)},
			},
		},
		ends: kadm.ListedOffsets{
			"orders": {0: {Offset: 0}, 1: {Offset: 0}, 2: {Offset: 1189}},
			"ledger": {0: {Offset: -1, Err: kerr.LeaderNotAvailable}},
		},
		groups: kadm.ListedGroups{"audit": {Group: "audit", ProtocolType: "consumer", State: "Stable"}},
		dirs: kadm.DescribedAllLogDirs{1: {"/tmp/kafka-logs": {Broker: 1, Dir: "/tmp/kafka-logs", Topics: kadm.DescribedLogDirTopics{
			"orders":             {2: {Broker: 1, Topic: "orders", Partition: 2, Size: 95_000}},
			"__consumer_offsets": {0: {Broker: 1, Topic: "__consumer_offsets", Partition: 0, Size: 1_000}},
		}}}},
		cfgs: kadm.ResourceConfigs{{Name: "orders", Configs: []kadm.Config{
			{Key: "retention.ms", Value: str("604800000")}, {Key: "retention.bytes", Value: str("-1")},
		}}},
	}
	f.setGroup("Stable", members, 15)
	return f
}

func (f *fake) setGroup(state string, members int, lag int64) {
	var ms []kadm.DescribedGroupMember
	for range members {
		ms = append(ms, kadm.DescribedGroupMember{MemberID: "kmeasure-consume-b65d718f", ClientID: "kmeasure-consume", ClientHost: "/172.24.0.4"})
	}
	var m *kadm.DescribedGroupMember
	if len(ms) > 0 {
		m = &ms[0]
	}
	f.groups["audit"] = kadm.ListedGroup{Group: "audit", State: state}
	f.lags = kadm.DescribedGroupLags{"audit": {Group: "audit", State: state, Members: ms, Lag: kadm.GroupLag{
		"orders": {
			0: {Member: m, Topic: "orders", Partition: 0, Commit: kadm.Offset{At: -1}, Lag: 0},
			1: {Member: m, Topic: "orders", Partition: 1, Commit: kadm.Offset{At: -1}, Lag: 0},
			2: {Member: m, Topic: "orders", Partition: 2, Commit: kadm.Offset{At: 1174}, Lag: lag},
		},
	}}}
}

func value(t *testing.T, out []metrics.Sample, name string, pairs ...string) float64 {
	t.Helper()
	for _, s := range out {
		if s.Name != name {
			continue
		}
		ok := true
		for i := 0; i+1 < len(pairs); i += 2 {
			found := false
			for _, l := range s.Labels {
				if l.Name == pairs[i] && l.Value == pairs[i+1] {
					found = true
				}
			}
			ok = ok && found
		}
		if ok {
			return s.Value
		}
	}
	t.Fatalf("no %s %v", name, pairs)
	return 0
}

func has(out []metrics.Sample, name string) bool {
	for _, s := range out {
		if s.Name == name {
			return true
		}
	}
	return false
}

func target() integrations.Target {
	return integrations.Target{ID: "svc1", Type: "kafka", Members: []integrations.Member{{Name: "kafka-e2e-kafka-1", Address: "127.0.0.1:1"}}}
}

func TestScrapeRecorded(t *testing.T) {
	f := recorded(1)
	f.down = map[string]bool{"kafka-2": true}
	now := time.Unix(1_794_535_000, 0)
	k := New()
	k.Ports = nil
	k.Now = func() time.Time { return now }
	k.Connect = func(context.Context, integrations.Target) (Admin, error) { return f, nil }
	res := k.Scrape(context.Background(), target(), true)
	if res.State != integrations.StateOK || res.ServiceVersion != "4.1" {
		t.Fatalf("state %q %q version %q", res.State, res.Error, res.ServiceVersion)
	}
	out := res.Samples
	checks := []struct {
		name  string
		want  float64
		pairs []string
	}{
		{"watchlog_kafka_brokers", 2, nil},
		{"watchlog_kafka_brokers_up", 1, nil},
		{"watchlog_kafka_broker_up", 0, []string{"broker", "2"}},
		{"watchlog_kafka_controller", 1, []string{"broker", "1"}},
		{"watchlog_kafka_partitions", 55, nil},
		{"watchlog_kafka_partitions_offline", 2, nil},
		{"watchlog_kafka_partitions_under_replicated", 3, nil},
		{"watchlog_kafka_topics", 2, nil},
		{"watchlog_kafka_topic_end_offset", 1189, []string{"topic", "orders"}},
		{"watchlog_kafka_topic_replication_factor", 2, []string{"topic", "orders"}},
		{"watchlog_kafka_topic_offline_partitions", 2, []string{"topic", "ledger"}},
		{"watchlog_kafka_broker_leaders", 53, []string{"broker", "1"}},
		{"watchlog_kafka_broker_partitions", 3, []string{"broker", "2"}},
		{"watchlog_kafka_groups", 1, nil},
		{"watchlog_kafka_group_members", 1, []string{"group", "audit"}},
		{"watchlog_kafka_group_state", 1, []string{"group", "audit", "state", "Stable"}},
		{"watchlog_kafka_group_lag", 15, []string{"group", "audit", "topic", "orders"}},
		{"watchlog_kafka_group_committed_offset", 1174, []string{"group", "audit", "topic", "orders"}},
		{"watchlog_kafka_topic_size_bytes", 95_000, []string{"topic", "orders"}},
		{"watchlog_kafka_broker_log_bytes", 96_000, []string{"broker", "1"}},
		{"watchlog_kafka_topic_retention_seconds", 604_800, []string{"topic", "orders"}},
		{"watchlog_kafka_topic_retention_bytes", -1, []string{"topic", "orders"}},
	}
	for _, c := range checks {
		if got := value(t, out, c.name, c.pairs...); got != c.want {
			t.Errorf("%s %v = %v, want %v", c.name, c.pairs, got, c.want)
		}
	}
	// Internal topics are left out of the topic series; a topic with no end offset has none.
	for _, s := range out {
		for _, l := range s.Labels {
			if l.Name == "topic" && strings.HasPrefix(l.Value, "__") {
				t.Errorf("internal topic in %s", s.Name)
			}
		}
	}
	members := res.Extra["members"].([]map[string]any)
	if len(members) != 1 || members[0]["client_host"] != "172.24.0.4" || members[0]["assigned"] != 3 {
		t.Errorf("members %v", members)
	}
	parts := res.Extra["partitions"].([]map[string]any)
	if len(parts) != 5 || parts[0]["topic"] != "ledger" || parts[0]["state"] != "offline" || parts[2]["state"] != "under_replicated" {
		t.Errorf("partitions %v", parts)
	}
	if q := res.Extra["quorum"].([]map[string]any); q[0]["voters"] != 1 {
		t.Errorf("quorum %v", q)
	}

	// The light scrape repeats the heavy numbers and sends no extra.
	light := k.Scrape(context.Background(), target(), false)
	if light.Extra != nil || value(t, light.Samples, "watchlog_kafka_topic_size_bytes", "topic", "orders") != 95_000 {
		t.Errorf("light scrape: extra %v", light.Extra)
	}
}

// The consumer is killed: the group stays Stable with its member for the session
// timeout (measured ~45 s), then Empty with none. The members it had are named, with the
// first scrape that saw it empty, until it has members again.
func TestLastMembers(t *testing.T) {
	f := recorded(1)
	now := time.Unix(1_794_535_000, 0)
	k := New()
	k.Ports = nil
	k.Now = func() time.Time { return now }
	k.Connect = func(context.Context, integrations.Target) (Admin, error) { return f, nil }
	res := k.Scrape(context.Background(), target(), true)
	if got := res.Extra["last_members"].([]map[string]any); len(got) != 0 {
		t.Fatalf("last members while consuming: %v", got)
	}
	f.setGroup("Empty", 0, 1029)
	now = now.Add(time.Minute)
	left := now.Unix()
	res = k.Scrape(context.Background(), target(), true)
	last := res.Extra["last_members"].([]map[string]any)
	if len(last) != 1 || last[0]["group"] != "audit" || last[0]["client_host"] != "172.24.0.4" || last[0]["left_at"] != left {
		t.Fatalf("last members: %v", last)
	}
	if value(t, res.Samples, "watchlog_kafka_group_members", "group", "audit") != 0 ||
		value(t, res.Samples, "watchlog_kafka_group_state", "group", "audit", "state", "Empty") != 1 {
		t.Error("empty group's series")
	}
	now = now.Add(5 * time.Minute)
	f.setGroup("Empty", 0, 2000)
	res = k.Scrape(context.Background(), target(), true)
	if last := res.Extra["last_members"].([]map[string]any); len(last) != 1 || last[0]["left_at"] != left {
		t.Fatalf("left_at moved: %v", last)
	}
	f.setGroup("Stable", 1, 0)
	res = k.Scrape(context.Background(), target(), true)
	if last := res.Extra["last_members"].([]map[string]any); len(last) != 0 {
		t.Fatalf("members back, still listed: %v", last)
	}
}

func TestPermissions(t *testing.T) {
	f := recorded(1)
	f.groupsErr = kerr.GroupAuthorizationFailed
	f.dirsErr = kerr.ClusterAuthorizationFailed
	k := New()
	k.Ports = nil
	k.Connect = func(context.Context, integrations.Target) (Admin, error) { return f, nil }
	res := k.Scrape(context.Background(), target(), true)
	got := map[string]string{}
	for _, p := range res.Permissions {
		got[p.Tab] = p.Missing
	}
	if got["consumer_groups/lag"] != "Describe on every group" || got["topics/largest"] != "Describe on the cluster" {
		t.Errorf("permissions %v", got)
	}
	if has(res.Samples, "watchlog_kafka_group_lag") {
		t.Error("lag without Describe on groups")
	}
	p := k.Probe(context.Background(), target())
	if p.Code != integrations.ProbePermission || len(p.Missing) != 2 || p.Facts["auth"] != "off" || p.Facts["brokers"] != 2 {
		t.Errorf("probe %+v", p)
	}
}

func TestConnectFails(t *testing.T) {
	k := New()
	k.Connect = func(context.Context, integrations.Target) (Admin, error) {
		return nil, kerr.SaslAuthenticationFailed
	}
	res := k.Scrape(context.Background(), target(), false)
	if res.State != integrations.StateError || res.ErrorCode != integrations.ProbeAuthFailed {
		t.Errorf("%+v", res)
	}
	if p := k.Probe(context.Background(), target()); p.Code != integrations.ProbeAuthFailed {
		t.Errorf("probe %+v", p)
	}
	if res := k.Scrape(context.Background(), integrations.Target{}, false); res.State != integrations.StateError {
		t.Error("no members")
	}
}

func TestVersionOf(t *testing.T) {
	for in, want := range map[string]string{"v4.1": "4.1", "at least v4.1": "4.1+", "unknown custom version": "", "v3.9": "3.9"} {
		if got := VersionOf(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestFallback(t *testing.T) {
	ms := []integrations.Member{{Name: "kafka-0", Address: "10.0.0.5:9092"}, {Name: "kafka-1", Address: "10.0.0.6:9092"}}
	if got := Fallback(ms, "kafka-1.kafka-headless.shop.svc.cluster.local"); got != "10.0.0.6:9092" {
		t.Errorf("pod DNS name → %q", got)
	}
	if got := Fallback(ms, "kafka"); got != "" {
		t.Errorf("two members, no match → %q", got)
	}
	one := []integrations.Member{{Name: "kafka-e2e-kafka-1", Address: "172.24.0.2:9092"}}
	if got := Fallback(one, "kafka"); got != "172.24.0.2:9092" {
		t.Errorf("Compose service name → %q", got)
	}
	if !loopback("localhost") || !loopback("127.0.0.1") || loopback("kafka") {
		t.Error("loopback")
	}
}

// Strimzi's JMX exporter names (its kafka-metrics ConfigMap): per-topic rows and the
// all-topics row; requests split by API version.
const strimzi = `# TYPE kafka_server_brokertopicmetrics_bytesin_total counter
kafka_server_brokertopicmetrics_bytesin_total 5000.0
kafka_server_brokertopicmetrics_bytesin_total{topic="orders"} 4000.0
kafka_server_brokertopicmetrics_bytesin_total{topic="ledger"} 1000.0
kafka_server_brokertopicmetrics_bytesout_total{topic="orders"} 3000.0
kafka_server_brokertopicmetrics_messagesin_total 120.0
kafka_network_requestmetrics_requests_total{request="Produce",version="9"} 40.0
kafka_network_requestmetrics_requests_total{request="Produce",version="11"} 2.0
kafka_network_requestmetrics_requests_total{request="Fetch",version="16"} 70.0
kafka_server_brokertopicmetrics_bytesin_oneminuterate 33.0
jvm_memory_bytes_used{area="heap"} 1.0e8
`

func TestInternals(t *testing.T) {
	out, err := Internals(strings.NewReader(strimzi), "kafka-0")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name  string
		want  float64
		pairs []string
	}{
		{"watchlog_kafka_internal_bytes_in_total", 5000, []string{"member", "kafka-0"}},
		{"watchlog_kafka_internal_bytes_out_total", 3000, nil},
		{"watchlog_kafka_internal_messages_in_total", 120, nil},
		{"watchlog_kafka_internal_requests_total", 42, []string{"request", "Produce"}},
		{"watchlog_kafka_internal_requests_total", 70, []string{"request", "Fetch"}},
	} {
		if got := value(t, out, c.name, c.pairs...); got != c.want {
			t.Errorf("%s %v = %v, want %v", c.name, c.pairs, got, c.want)
		}
	}
	if len(out) != 5 {
		t.Errorf("%d samples: %v", len(out), out)
	}
}
