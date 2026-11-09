// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"net"
	"strings"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Integration reads one kind of service. Implementations run a fixed list of
// read-only statements or commands, written in code; nothing sent by the backend is
// ever executed (ADR-131).
type Integration interface {
	// Scrape reads every member of the target. heavy marks the slower tier (tables,
	// statements, queues). It must respect ctx's deadline.
	Scrape(ctx context.Context, t Target, heavy bool) Result
}

// Prober is implemented by integrations that can test access: connect, log in with the
// target's Auth and check the user's privileges, as the connect drawer's test does.
type Prober interface {
	Probe(ctx context.Context, t Target) ProbeResult
}

// Result is what one scrape of one target produced.
type Result struct {
	Samples        []metrics.Sample
	State          string
	Error          string
	ServiceVersion string
	Members        []MemberStatus
	Permissions    []Permission
	// Facts are a few numbers or words for the connect drawer ("312 MB used").
	Facts map[string]any
	// Excess lists privileges beyond what WatchLog needs (superuser, +@all), ADR-134.
	Excess []string
}

// Registry maps a service type to its integration. Types without one get the TCP
// check, so a service monitored before its integration exists still shows whether it
// answers.
type Registry map[string]Integration

// For returns the integration for a type.
func (r Registry) For(typ string) Integration {
	if i, ok := r[typ]; ok {
		return i
	}
	return TCPCheck{}
}

// DialTimeout bounds one connection attempt (ADR-131: 5 s per call).
const DialTimeout = 5 * time.Second

// TCPCheck only tells whether each member accepts a connection, and how fast.
type TCPCheck struct {
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
}

// Scrape implements Integration.
func (c TCPCheck) Scrape(ctx context.Context, t Target, _ bool) Result {
	dial := c.Dial
	if dial == nil {
		d := net.Dialer{Timeout: DialTimeout}
		dial = d.DialContext
	}
	res := Result{State: StateOK}
	up := 0
	for _, m := range t.Members {
		start := time.Now()
		conn, err := dial(ctx, "tcp", m.Address)
		ms := MemberStatus{Name: m.Name, Up: err == nil}
		if err == nil {
			_ = conn.Close()
			up++
			res.Samples = append(res.Samples, metrics.New("watchlog_integration_connect_seconds",
				time.Since(start).Seconds(), "member", m.Name))
		} else {
			ms.Error = shortError(err)
		}
		res.Members = append(res.Members, ms)
	}
	switch {
	case len(t.Members) == 0:
		res.State, res.Error = StateError, "no member to connect to: no pod or container of this service has an address yet"
	case up == 0:
		res.State, res.Error = StateError, res.Members[0].Error
	}
	return res
}

// shortError keeps errors one line and within the backend's limit, without addresses
// repeated from the dial error's prefix.
func shortError(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && strings.HasPrefix(msg, "dial ") {
		msg = msg[i+2:]
	}
	msg = strings.Join(strings.Fields(msg), " ")
	if len(msg) > maxErrorLen {
		msg = msg[:maxErrorLen]
	}
	return msg
}
