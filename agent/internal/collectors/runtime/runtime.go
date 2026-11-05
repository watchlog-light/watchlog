// SPDX-License-Identifier: AGPL-3.0-only

// Package runtime collects Docker container state, usage and inventory (SPEC §4.4, §6.3).
package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/docker"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/redact"
)

// Refresh intervals keep Docker API calls (and the inspect responses that carry
// environment variables) to a minimum.
const (
	inspectRefresh = 5 * time.Minute
	sizeRefresh    = 10 * time.Minute
	versionRefresh = 10 * time.Minute
	// Unhealthy containers are re-inspected more often so the probe log stays recent.
	unhealthyRefresh = time.Minute
)

// MaxProbeOutput is the size limit of one probe's output and of the check command (ADR-047).
const MaxProbeOutput = 512

// Docker is the subset of the Docker client the collector uses.
type Docker interface {
	Negotiate(ctx context.Context) (docker.Version, error)
	ListContainers(ctx context.Context, withSize bool) ([]docker.ContainerSummary, error)
	Inspect(ctx context.Context, id string) (docker.ContainerState, error)
	Events(ctx context.Context, since time.Time, fn func(docker.Event)) error
}

// Cgroups reads per-container usage.
type Cgroups interface {
	Container(id string) (containers.Stats, error)
	Network(pid int) (rx, tx float64, err error)
}

type inspected struct {
	state docker.ContainerState
	at    time.Time
	dirty bool
}

// Collector implements the Docker runtime and containers collectors.
type Collector struct {
	docker  Docker
	cgroups Cgroups
	log     *slog.Logger
	now     func() time.Time

	mu        sync.Mutex
	version   docker.Version
	versionAt time.Time
	states    map[string]*inspected
	sizes     map[string]int64
	sizesAt   time.Time
	ooms      map[string]int
	inventory Inventory
	// identities is replaced (never mutated) on each collection.
	identities map[string]Identity
	// pending holds containers changed by die/oom/health_status events, for Delta.
	pending map[string]bool
	changed chan struct{}

	// events are Docker events waiting to be sent (events.go).
	events        []EventRecord
	eventsDropped int

	// HealthOutput sends probe output (redacted, one line); false sends exit codes only.
	HealthOutput bool
	// Host names the host in the events sent.
	Host string
}

// New returns a collector.
func New(d Docker, cg Cgroups, log *slog.Logger) *Collector {
	return &Collector{docker: d, cgroups: cg, log: log, now: time.Now,
		states: map[string]*inspected{}, sizes: map[string]int64{}, ooms: map[string]int{},
		pending: map[string]bool{}, changed: make(chan struct{}, 1), HealthOutput: true}
}

// Changes signals that events changed containers; call Delta to get them.
func (c *Collector) Changes() <-chan struct{} { return c.changed }

// Identity names a container and gives its addresses, for eBPF flows (ADR-102).
type Identity struct {
	Name           string
	ComposeProject string
	ComposeService string
	IPs            []string
}

// Identities are the containers seen at the last collection, by full ID.
func (c *Collector) Identities() map[string]Identity {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.identities
}

// ContainerIDs are the containers seen at the last collection (for eBPF flow
// attribution, ADR-099).
func (c *Collector) ContainerIDs() []string {
	ids := c.Identities()
	out := make([]string, 0, len(ids))
	for id := range ids {
		out = append(out, id)
	}
	return out
}

// WatchEvents follows the Docker event stream until ctx ends, reconnecting on errors.
// Events mark containers for re-inspection and count OOM kills.
func (c *Collector) WatchEvents(ctx context.Context) {
	since := c.now()
	for ctx.Err() == nil {
		err := c.docker.Events(ctx, since, c.handleEvent)
		if ctx.Err() != nil {
			return
		}
		c.log.Debug("docker event stream ended; reconnecting", "err", err)
		since = c.now().Add(-time.Second)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (c *Collector) handleEvent(e docker.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.queueEvent(e)
	if e.Type == "image" {
		return
	}
	if e.Action == "oom" {
		c.ooms[e.Actor.ID]++
	}
	if st, ok := c.states[e.Actor.ID]; ok {
		st.dirty = true
	}
	// health_status events carry the new status ("health_status: unhealthy") and fire
	// only on transitions (measured), so each one is worth an immediate update.
	if e.Action == "die" || e.Action == "oom" || strings.HasPrefix(e.Action, "health_status") {
		c.pending[e.Actor.ID] = true
		select {
		case c.changed <- struct{}{}:
		default:
		}
	}
	if e.Action == "destroy" {
		delete(c.states, e.Actor.ID)
		delete(c.sizes, e.Actor.ID)
		delete(c.ooms, e.Actor.ID)
	}
}

// Collect lists containers and returns their metrics.
func (c *Collector) Collect() ([]metrics.Sample, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := c.now()
	var errs []error

	if now.Sub(c.versionAt) > versionRefresh {
		if v, err := c.docker.Negotiate(ctx); err != nil {
			errs = append(errs, fmt.Errorf("docker version: %w", err))
		} else {
			c.mu.Lock()
			c.version, c.versionAt = v, now
			c.mu.Unlock()
		}
	}
	withSize := now.Sub(c.sizesAt) > sizeRefresh
	list, err := c.docker.ListContainers(ctx, withSize)
	if err != nil {
		return nil, errors.Join(append(errs, fmt.Errorf("docker list: %w", err))...)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if withSize {
		c.sizesAt = now
		for _, s := range list {
			if s.SizeRw != nil {
				c.sizes[s.ID] = *s.SizeRw
			}
		}
	}

	var out []metrics.Sample
	if c.version.Version != "" {
		out = append(out, metrics.New("watchlog_docker_info", 1, "docker_version", c.version.Version,
			"kernel", c.version.KernelVersion, "os", c.version.Os, "arch", c.version.Arch))
	}
	seen := map[string]bool{}
	inv := Inventory{Host: HostObject{DockerVersion: c.version.Version, APIVersion: c.version.APIVersion,
		Os: c.version.Os, Arch: c.version.Arch, KernelVersion: c.version.KernelVersion},
		Containers: []ContainerObject{}} // [] not null: the backend expects an array

	for _, s := range list {
		seen[s.ID] = true
		st := c.states[s.ID]
		unhealthy := s.Health != nil && s.Health.Status == "unhealthy"
		if st == nil || st.dirty || now.Sub(st.at) > inspectRefresh || s.State == "restarting" ||
			(unhealthy && now.Sub(st.at) > unhealthyRefresh) ||
			(st.state.State.Running != (s.State == "running")) {
			fresh, err := c.docker.Inspect(ctx, s.ID)
			if err != nil {
				errs = append(errs, fmt.Errorf("docker inspect %s: %w", s.Name(), err))
			} else {
				st = &inspected{state: fresh, at: now}
				c.states[s.ID] = st
			}
		}
		labels := containerLabels(s)
		out = append(out, c.containerMetrics(s, st, labels, &errs)...)
		inv.Containers = append(inv.Containers, c.containerObject(s, st))
	}
	for id := range c.states {
		if !seen[id] {
			delete(c.states, id)
			delete(c.sizes, id)
		}
	}
	sort.Slice(inv.Containers, func(i, j int) bool { return inv.Containers[i].Name < inv.Containers[j].Name })
	c.inventory = inv
	ids := make(map[string]Identity, len(list))
	for _, s := range list {
		id := Identity{Name: s.Name(), ComposeProject: s.Labels["com.docker.compose.project"],
			ComposeService: s.Labels["com.docker.compose.service"]}
		for _, n := range s.NetworkSettings.Networks {
			for _, ip := range []string{n.IPAddress, n.GlobalIPv6Address} {
				if ip != "" {
					id.IPs = append(id.IPs, ip)
				}
			}
		}
		ids[s.ID] = id
	}
	c.identities = ids
	return out, errors.Join(errs...)
}

func containerLabels(s docker.ContainerSummary) []string {
	l := []string{"container", s.Name(), "image", s.Image}
	if p := s.Labels["com.docker.compose.project"]; p != "" {
		l = append(l, "compose_project", p)
	}
	if svc := s.Labels["com.docker.compose.service"]; svc != "" {
		l = append(l, "compose_service", svc)
	}
	return l
}

func with(labels []string, extra ...string) []string {
	return append(append(make([]string, 0, len(labels)+len(extra)), labels...), extra...)
}

func (c *Collector) containerMetrics(s docker.ContainerSummary, st *inspected, labels []string, errs *[]error) []metrics.Sample {
	out := []metrics.Sample{metrics.New("watchlog_container_state", 1, with(labels, "state", s.State)...)}
	if s.Health != nil && s.Health.Status != "" && s.Health.Status != "none" {
		out = append(out, metrics.New("watchlog_container_health", 1, with(labels, "status", s.Health.Status)...))
	}
	if size, ok := c.sizes[s.ID]; ok {
		out = append(out, metrics.New("watchlog_container_fs_bytes", float64(size), labels...))
	}
	out = append(out, metrics.New("watchlog_container_oom_events_total", float64(c.ooms[s.ID]), labels...))
	if st == nil {
		return out
	}
	out = append(out, metrics.New("watchlog_container_restarts_total", float64(st.state.RestartCount), labels...))
	if !st.state.State.Running {
		return out
	}
	if t, err := time.Parse(time.RFC3339Nano, st.state.State.StartedAt); err == nil {
		out = append(out, metrics.New("watchlog_container_start_time_seconds", float64(t.Unix()), labels...))
	}

	cg, err := c.cgroups.Container(s.ID)
	switch {
	case errors.Is(err, containers.ErrNotFound):
		// The container exited between inspect and now (crash loops); not an error.
	case err != nil:
		*errs = append(*errs, fmt.Errorf("cgroup %s: %w", s.Name(), err))
	default:
		out = append(out,
			metrics.New("watchlog_container_cpu_seconds_total", cg.CPUSeconds, labels...),
			metrics.New("watchlog_container_cpu_throttled_seconds_total", cg.CPUThrottledSeconds, labels...),
			metrics.New("watchlog_container_memory_working_set_bytes", cg.MemoryWorkingSet, labels...),
			metrics.New("watchlog_container_fs_io_bytes_total", cg.IOReadBytes, with(labels, "dir", "read")...),
			metrics.New("watchlog_container_fs_io_bytes_total", cg.IOWriteBytes, with(labels, "dir", "write")...),
		)
		if cg.CPULimitCores != nil {
			out = append(out, metrics.New("watchlog_container_cpu_limit_cores", *cg.CPULimitCores, labels...))
		}
		if cg.MemoryLimit != nil {
			out = append(out, metrics.New("watchlog_container_memory_limit_bytes", *cg.MemoryLimit, labels...))
		}
	}
	// Host-network containers see the host's interfaces; their traffic is in the host metrics.
	if s.HostConfig.NetworkMode != "host" && st.state.State.Pid > 0 {
		rx, tx, err := c.cgroups.Network(st.state.State.Pid)
		if err != nil {
			*errs = append(*errs, fmt.Errorf("network %s: %w", s.Name(), err))
		} else {
			out = append(out,
				metrics.New("watchlog_container_network_bytes_total", rx, with(labels, "dir", "rx")...),
				metrics.New("watchlog_container_network_bytes_total", tx, with(labels, "dir", "tx")...),
			)
		}
	}
	return out
}

// HostObject is the Docker host's inventory entry.
type HostObject struct {
	DockerVersion string `json:"docker_version"`
	APIVersion    string `json:"api_version"`
	Os            string `json:"os"`
	Arch          string `json:"arch"`
	KernelVersion string `json:"kernel_version"`
}

// PortObject is a published port.
type PortObject struct {
	IP          string `json:"ip,omitempty"`
	PublicPort  uint16 `json:"public_port"`
	PrivatePort uint16 `json:"private_port"`
	Protocol    string `json:"protocol"`
}

// ContainerObject is a container's inventory entry. It never includes the
// command line or environment (either can contain secrets).
type ContainerObject struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Image          string       `json:"image"`
	State          string       `json:"state"`
	Status         string       `json:"status"`
	Health         string       `json:"health,omitempty"`
	RestartCount   int          `json:"restart_count"`
	ExitCode       int          `json:"exit_code"`
	OOMKilled      bool         `json:"oom_killed"`
	CreatedAt      int64        `json:"created_at"`
	StartedAt      string       `json:"started_at,omitempty"`
	Ports          []PortObject `json:"ports,omitempty"`
	ComposeProject string       `json:"compose_project,omitempty"`
	ComposeService string       `json:"compose_service,omitempty"`
	// Networks are the user-defined networks the container is on (not bridge, host or
	// none): the service map's topology without eBPF.
	Networks     []string      `json:"networks,omitempty"`
	SizeRw       *int64        `json:"size_rw,omitempty"`
	Restarting   bool          `json:"restarting,omitempty"`
	Error        string        `json:"error,omitempty"`
	FinishedAt   string        `json:"finished_at,omitempty"`
	HealthDetail *HealthObject `json:"health_detail,omitempty"`
}

// HealthObject explains a container's health status: the check and its last probes.
type HealthObject struct {
	Status        string        `json:"status"`
	FailingStreak int           `json:"failing_streak"`
	Probes        []ProbeObject `json:"probes"`
	Check         *CheckObject  `json:"check,omitempty"`
}

// ProbeObject is one health check run. Output is redacted and one line, and is
// omitted entirely with WATCHLOG_HEALTH_OUTPUT=false.
type ProbeObject struct {
	Start    string `json:"start"`
	End      string `json:"end"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output,omitempty"`
}

// CheckObject is the health check configuration with daemon defaults applied.
type CheckObject struct {
	Command      string  `json:"command"`
	Shell        bool    `json:"shell"`
	IntervalS    float64 `json:"interval_s"`
	TimeoutS     float64 `json:"timeout_s"`
	StartPeriodS float64 `json:"start_period_s"`
	Retries      int     `json:"retries"`
}

// Inventory is the latest host and container snapshot.
type Inventory struct {
	Host       HostObject        `json:"host"`
	Containers []ContainerObject `json:"containers"`
}

func (c *Collector) containerObject(s docker.ContainerSummary, st *inspected) ContainerObject {
	o := ContainerObject{
		ID: s.ID, Name: s.Name(), Image: s.Image, State: s.State, Status: s.Status, CreatedAt: s.Created,
		ComposeProject: s.Labels["com.docker.compose.project"], ComposeService: s.Labels["com.docker.compose.service"],
	}
	if s.Health != nil && s.Health.Status != "none" {
		o.Health = s.Health.Status
	}
	for name := range s.NetworkSettings.Networks {
		if name != "bridge" && name != "host" && name != "none" {
			o.Networks = append(o.Networks, name)
		}
	}
	sort.Strings(o.Networks)
	seenPorts := map[PortObject]bool{}
	for _, p := range s.Ports {
		if p.PublicPort == 0 {
			continue // only published ports
		}
		po := PortObject{PublicPort: p.PublicPort, PrivatePort: p.PrivatePort, Protocol: p.Type}
		if p.IP != "0.0.0.0" && p.IP != "::" {
			po.IP = p.IP
		}
		if !seenPorts[po] { // IPv4 and IPv6 bindings of the same port collapse
			seenPorts[po] = true
			o.Ports = append(o.Ports, po)
		}
	}
	if size, ok := c.sizes[s.ID]; ok {
		o.SizeRw = &size
	}
	if st != nil {
		o.RestartCount = st.state.RestartCount
		o.ExitCode = st.state.State.ExitCode
		o.OOMKilled = st.state.State.OOMKilled || c.ooms[s.ID] > 0
		if st.state.State.Running {
			o.StartedAt = st.state.State.StartedAt
		}
		o.Restarting = st.state.State.Restarting
		o.Error = redact.Line(st.state.State.Error, MaxProbeOutput)
		if !st.state.State.Running && !strings.HasPrefix(st.state.State.FinishedAt, "0001-") {
			o.FinishedAt = st.state.State.FinishedAt
		}
		o.HealthDetail = c.healthObject(st.state)
	}
	return o
}

// Docker's defaults for a health check field left at zero.
const (
	defaultInterval = 30 * time.Second
	defaultTimeout  = 30 * time.Second
	defaultRetries  = 3
)

func (c *Collector) healthObject(st docker.ContainerState) *HealthObject {
	h := st.State.Health
	if h == nil || h.Status == "" || h.Status == "none" {
		return nil
	}
	out := &HealthObject{Status: h.Status, FailingStreak: h.FailingStreak, Probes: []ProbeObject{}}
	log := h.Log
	if len(log) > 5 {
		log = log[len(log)-5:]
	}
	for _, p := range log {
		po := ProbeObject{Start: p.Start, End: p.End, ExitCode: p.ExitCode}
		if c.HealthOutput {
			po.Output = redact.Line(p.Output, MaxProbeOutput)
		}
		out.Probes = append(out.Probes, po)
	}
	out.Check = checkObject(st.Config.Healthcheck)
	return out
}

func checkObject(hc *docker.Healthcheck) *CheckObject {
	if hc == nil || len(hc.Test) < 2 || hc.Test[0] == "NONE" {
		return nil
	}
	co := &CheckObject{Shell: hc.Test[0] == "CMD-SHELL", Retries: hc.Retries,
		IntervalS: seconds(hc.Interval, defaultInterval), TimeoutS: seconds(hc.Timeout, defaultTimeout),
		StartPeriodS: seconds(hc.StartPeriod, 0)}
	if co.Retries == 0 {
		co.Retries = defaultRetries
	}
	if co.Shell {
		co.Command = hc.Test[1]
	} else {
		args := make([]string, 0, len(hc.Test)-1)
		for _, a := range hc.Test[1:] {
			if a == "" || strings.ContainsAny(a, " \t'\"$") {
				a = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
			}
			args = append(args, a)
		}
		co.Command = strings.Join(args, " ")
	}
	co.Command = redact.Line(co.Command, MaxProbeOutput)
	return co
}

func seconds(ns int64, fallback time.Duration) float64 {
	if ns <= 0 {
		return fallback.Seconds()
	}
	return time.Duration(ns).Seconds()
}

// Delta re-inspects the containers changed by events since the last call and returns
// an inventory holding only them, or nil when there is nothing to send. The next
// snapshot carries the same data, so a delta that fails to send is not retried.
func (c *Collector) Delta(ctx context.Context) (*Inventory, error) {
	c.mu.Lock()
	ids := c.pending
	c.pending = map[string]bool{}
	c.mu.Unlock()
	if len(ids) == 0 {
		return nil, nil
	}
	list, err := c.docker.ListContainers(ctx, false)
	if err != nil {
		return nil, fmt.Errorf("docker list: %w", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	inv := &Inventory{Host: c.inventory.Host, Containers: []ContainerObject{}}
	var errs []error
	for _, s := range list {
		if !ids[s.ID] {
			continue // destroyed meanwhile, or not ours to report
		}
		fresh, err := c.docker.Inspect(ctx, s.ID)
		if err != nil {
			errs = append(errs, fmt.Errorf("docker inspect %s: %w", s.Name(), err))
			continue
		}
		st := &inspected{state: fresh, at: c.now()}
		c.states[s.ID] = st
		inv.Containers = append(inv.Containers, c.containerObject(s, st))
	}
	if len(inv.Containers) == 0 {
		return nil, errors.Join(errs...)
	}
	sort.Slice(inv.Containers, func(i, j int) bool { return inv.Containers[i].Name < inv.Containers[j].Name })
	return inv, errors.Join(errs...)
}

// Inventory returns the snapshot from the last Collect and a hash for change detection.
func (c *Collector) Inventory() (Inventory, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	inv := c.inventory
	// Status text ("Up 3 minutes") changes every scrape; leave it out of the hash.
	stable := make([]ContainerObject, len(inv.Containers))
	for i, o := range inv.Containers {
		o.Status = ""
		stable[i] = o
	}
	b, _ := json.Marshal(struct {
		H HostObject
		C []ContainerObject
	}{inv.Host, stable})
	sum := sha256.Sum256(b)
	return inv, fmt.Sprintf("%x", sum[:8])
}
