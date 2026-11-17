// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"os"
	"sort"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Limit is the most process groups a server reports (ADR-208); the rest are one "other
// processes" group, and the count left out is a self-metric.
const Limit = 50

// OtherGroup holds the processes over the limit.
const OtherGroup = "other processes"

// GoneKeep is how long a group whose every instance exited is still reported (instances 0),
// so "a process group gone" can fire and resolve.
const GoneKeep = time.Hour

// ticksPerSecond is USER_HZ, the unit of /proc/<pid>/stat's times on Linux.
const ticksPerSecond = 100

// Exit is a process's end, from eBPF's sched_process_exit (ADR-210), when known.
type Exit struct {
	Code   int  // the exit status
	Signal int  // the terminating signal, 0 for a normal exit
	OOM    bool // killed by the kernel's OOM killer
}

// Collector groups processes and keeps each group's counters across scrapes.
type Collector struct {
	Reader *Reader
	// Hints returns pm2's and supervisord's names; called once a scrape.
	Hints func() Hints
	// Rules are the fleet's own rules (from the backend), already compiled.
	Rules func() []Rule
	// Exits, when set, returns what is known about processes that ended since the last call
	// (eBPF); a pid absent from it ended with an unknown status.
	Exits func() map[int]Exit
	// Self is the agent's own pid: it and its children are never grouped.
	Self  int
	Limit int
	Now   func() time.Time

	live    map[int]tracked
	groups  map[string]*group
	scanned bool
	// Dropped is how many groups were folded into OtherGroup at the last scrape.
	Dropped int
}

type tracked struct {
	key        string
	startTicks uint64
	cpuTicks   uint64
}

type group struct {
	name, unit string
	by         string
	deadTicks  uint64
	starts     float64
	exits      map[string]float64
	oomKills   float64
	releases   float64
	exeID      string
	lastSeen   time.Time
	// this scrape
	instances, threads   int
	rss, pss             uint64
	openFiles            int
	liveTicks            uint64
	pssKnown, filesKnown bool
}

func (c *Collector) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Collect scans /proc and returns the groups' series.
func (c *Collector) Collect() ([]metrics.Sample, error) {
	if c.live == nil {
		c.live, c.groups = map[int]tracked{}, map[string]*group{}
	}
	pids, err := c.Reader.PIDs()
	if err != nil {
		return nil, err
	}
	procs := make(map[int]Proc, len(pids))
	for _, pid := range pids {
		if p, ok := c.Reader.Read(pid); ok {
			procs[pid] = p
		}
	}
	var hints Hints
	if c.Hints != nil {
		hints = c.Hints()
	}
	var rules []Rule
	if c.Rules != nil {
		rules = c.Rules()
	}
	now := c.now()
	for _, g := range c.groups {
		g.instances, g.threads, g.rss, g.pss, g.openFiles, g.liveTicks = 0, 0, 0, 0, 0, 0
		g.pssKnown, g.filesKnown = false, false
	}

	// Name every process; then decide which unit-held groups are worth their own series.
	type named struct {
		p          Proc
		name, unit string
		by         string
	}
	var all []named
	perUnit := map[string]map[string]bool{}
	for _, p := range procs {
		if c.excluded(p) || InContainer(p.Cgroup) {
			continue
		}
		unit := Unit(p.Cgroup)
		parent := procs[p.PPID].Comm
		name, by := Name(p, parent, unit, rules, hints)
		all = append(all, named{p, name, unit, by})
		if unit != "" {
			if perUnit[unit] == nil {
				perUnit[unit] = map[string]bool{}
			}
			perUnit[unit][name] = true
		}
	}

	seen := map[int]bool{}
	for _, n := range all {
		// Inside a unit, a group only by a manager's or user's rule, or when the unit holds
		// several: nginx's processes alone in nginx.service are the service itself.
		if n.unit != "" && n.by == "exe" && len(perUnit[n.unit]) == 1 {
			continue
		}
		key := n.unit + "\x00" + n.name
		g := c.groups[key]
		if g == nil {
			g = &group{name: n.name, unit: n.unit, by: n.by, exits: map[string]float64{}}
			c.groups[key] = g
		}
		p := n.p
		seen[p.PID] = true
		prev, known := c.live[p.PID]
		if known && prev.startTicks != p.StartTicks {
			c.ended(prev, Exit{Code: -1}) // the pid was reused
			known = false
		}
		if !known && c.scanned {
			g.starts++
		}
		c.live[p.PID] = tracked{key: key, startTicks: p.StartTicks, cpuTicks: p.CPUTicks}
		g.instances++
		g.threads += p.Threads
		g.rss += p.RSSBytes
		if p.PSSBytes > 0 {
			g.pss += p.PSSBytes
			g.pssKnown = true
		}
		if p.OpenFiles >= 0 {
			g.openFiles += p.OpenFiles
			g.filesKnown = true
		}
		g.liveTicks += p.CPUTicks
		g.lastSeen = now
		// A release: the group's executable replaced on disk (a new binary, a deploy).
		if p.ExeID != "" {
			if g.exeID != "" && g.exeID != p.ExeID {
				g.releases++
			}
			g.exeID = p.ExeID
		}
	}

	var exits map[int]Exit
	if c.Exits != nil {
		exits = c.Exits()
	}
	for pid, t := range c.live {
		if seen[pid] {
			continue
		}
		e, ok := exits[pid]
		if !ok {
			e = Exit{Code: -1}
		}
		c.ended(t, e)
		delete(c.live, pid)
	}
	for key, g := range c.groups {
		if g.instances == 0 && now.Sub(g.lastSeen) > GoneKeep {
			delete(c.groups, key)
		}
	}
	c.scanned = true
	return c.samples(), nil
}

// excluded: the agent itself and its children.
func (c *Collector) excluded(p Proc) bool {
	self := c.Self
	if self == 0 {
		self = os.Getpid()
	}
	return p.PID == self || p.PPID == self
}

func (c *Collector) ended(t tracked, e Exit) {
	g := c.groups[t.key]
	if g == nil {
		return
	}
	g.deadTicks += t.cpuTicks
	switch {
	case e.OOM:
		g.oomKills++
		g.exits["signal"]++
	case e.Code < 0:
		g.exits["unknown"]++
	case e.Signal != 0:
		g.exits["signal"]++
	case e.Code == 0:
		g.exits["ok"]++
	default:
		g.exits["error"]++
	}
}

func (c *Collector) samples() []metrics.Sample {
	list := make([]*group, 0, len(c.groups))
	for _, g := range c.groups {
		list = append(list, g)
	}
	// The busiest first: CPU over the group's life, then memory, then the name.
	sort.Slice(list, func(i, j int) bool {
		ci, cj := list[i].deadTicks+list[i].liveTicks, list[j].deadTicks+list[j].liveTicks
		if ci != cj {
			return ci > cj
		}
		if list[i].rss != list[j].rss {
			return list[i].rss > list[j].rss
		}
		return list[i].unit+list[i].name < list[j].unit+list[j].name
	})
	limit := c.Limit
	if limit <= 0 {
		limit = Limit
	}
	c.Dropped = 0
	var out []metrics.Sample
	other := &group{name: OtherGroup, exits: map[string]float64{}}
	for i, g := range list {
		if i >= limit {
			c.Dropped++
			other.deadTicks += g.deadTicks
			other.liveTicks += g.liveTicks
			other.instances += g.instances
			other.threads += g.threads
			other.rss += g.rss
			continue
		}
		out = append(out, groupSamples(g)...)
	}
	if c.Dropped > 0 {
		out = append(out,
			metrics.New("watchlog_process_group_cpu_seconds_total", float64(other.deadTicks+other.liveTicks)/ticksPerSecond, "group", OtherGroup, "unit", ""),
			metrics.New("watchlog_process_group_memory_rss_bytes", float64(other.rss), "group", OtherGroup, "unit", ""),
			metrics.New("watchlog_process_group_instances", float64(other.instances), "group", OtherGroup, "unit", ""),
		)
	}
	out = append(out, metrics.New("watchlog_agent_process_groups_dropped", float64(c.Dropped)))
	return out
}

func groupSamples(g *group) []metrics.Sample {
	l := []string{"group", g.name, "unit", g.unit}
	out := []metrics.Sample{
		metrics.New("watchlog_process_group_cpu_seconds_total", float64(g.deadTicks+g.liveTicks)/ticksPerSecond, l...),
		metrics.New("watchlog_process_group_memory_rss_bytes", float64(g.rss), l...),
		metrics.New("watchlog_process_group_instances", float64(g.instances), l...),
		metrics.New("watchlog_process_group_threads", float64(g.threads), l...),
		metrics.New("watchlog_process_group_starts_total", g.starts, l...),
		metrics.New("watchlog_process_group_releases_total", g.releases, l...),
		metrics.New("watchlog_process_group_oom_kills_total", g.oomKills, l...),
	}
	if g.pssKnown {
		out = append(out, metrics.New("watchlog_process_group_memory_pss_bytes", float64(g.pss), l...))
	}
	if g.filesKnown {
		out = append(out, metrics.New("watchlog_process_group_open_files", float64(g.openFiles), l...))
	}
	for _, kind := range []string{"ok", "error", "signal", "unknown"} {
		out = append(out, metrics.New("watchlog_process_group_exits_total", g.exits[kind], append(l, "exit", kind)...))
	}
	return out
}
