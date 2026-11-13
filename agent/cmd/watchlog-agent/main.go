// SPDX-License-Identifier: AGPL-3.0-only

// Command watchlog-agent collects node, container and network metrics for
// WatchLog (SPEC §6).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/containers"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/host"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/kubepods"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/network"
	"github.com/watchlog-light/watchlog/agent/internal/collectors/runtime"
	"github.com/watchlog-light/watchlog/agent/internal/config"
	"github.com/watchlog-light/watchlog/agent/internal/docker"
	"github.com/watchlog-light/watchlog/agent/internal/ebpf"
	"github.com/watchlog-light/watchlog/agent/internal/logs"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
	"github.com/watchlog-light/watchlog/agent/internal/runner"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
	"github.com/watchlog-light/watchlog/agent/internal/version"
)

// Buffer limits (SPEC §5.2, ADR-022).
const (
	bufferMaxBytes = 200 << 20
	bufferMaxAge   = 15 * time.Minute
)

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// helmRelease keeps a chart-provided name only when it looks like a Kubernetes name
// (namespace/release or a chart name), so the heartbeat never carries anything else.
func helmRelease(v string) string {
	if len(v) > 128 {
		return ""
	}
	if strings.Trim(v, "abcdefghijklmnopqrstuvwxyz0123456789-./") != "" {
		return ""
	}
	return v
}

// selfContainerID is the agent's own container in docker mode, read from its own
// mountinfo (not the host's).
func selfContainerID(mode config.Mode) string {
	if mode != config.ModeDocker {
		return ""
	}
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	return config.SelfContainerID(string(b))
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}

func run(args []string, stdout io.Writer) int {
	fs := flag.NewFlagSet("watchlog-agent", flag.ContinueOnError)
	modeFlag := fs.String("mode", string(config.ModeNode), "collection mode: node, cluster or docker")
	showVersion := fs.Bool("version", false, "print version and exit")
	once := fs.Bool("once", false, "collect one scrape, print it and exit")
	output := fs.String("output", "text", "output format for --once: text")
	paths := config.DefaultHostPaths
	fs.StringVar(&paths.Proc, "host-proc", paths.Proc, "host procfs mount")
	fs.StringVar(&paths.Sys, "host-sys", paths.Sys, "host sysfs mount")
	fs.StringVar(&paths.RootFS, "host-root", paths.RootFS, "host root filesystem mount (read-only)")
	hostname := fs.String("hostname", envOr("WATCHLOG_HOSTNAME", os.Getenv("NODE_NAME")),
		"host or node label (default: NODE_NAME in Kubernetes, else the host's /etc/hostname)")
	// Kubernetes node mode (ADR-049, ADR-051, ADR-066).
	saDir := "/var/run/secrets/kubernetes.io/serviceaccount"
	kubeletURL := fs.String("kubelet-url", envOr("WATCHLOG_KUBELET_URL", kubeletDefault()), "kubelet /stats/summary URL (node mode)")
	kubeletTLS := fs.String("kubelet-tls", envOr("WATCHLOG_KUBELET_TLS", kubepods.TLSAuto), "kubelet TLS: auto, verify or skip")
	podmapURL := fs.String("podmap-url", os.Getenv("WATCHLOG_PODMAP_URL"), "cluster-agent pod map base URL (node mode)")
	podmapCA := fs.String("podmap-ca", envOr("WATCHLOG_PODMAP_CA", "/etc/watchlog/podmap/ca.crt"), "CA of the cluster-agent's pod map certificate")
	podmapToken := fs.String("podmap-token", envOr("WATCHLOG_PODMAP_TOKEN", "/var/run/secrets/watchlog/podmap/token"),
		"projected ServiceAccount token with audience "+podmap.Audience)
	endpoint := fs.String("endpoint", os.Getenv("WATCHLOG_ENDPOINT"), "WatchLog base URL, e.g. https://watchlog.example.com")
	bufferDir := fs.String("buffer-dir", envOr("WATCHLOG_BUFFER_DIR", "/var/lib/watchlog-agent/buffer"), "on-disk buffer directory")
	interval := fs.Duration("interval", 15*time.Second, "collection interval")
	dockerSocket := fs.String("docker-socket", envOr("WATCHLOG_DOCKER_SOCKET", "/var/run/docker.sock"), "Docker socket (docker mode, read-only use)")
	ebpfFlag := fs.Bool("ebpf", envOr("WATCHLOG_EBPF", "true") != "false",
		"eBPF network flows (node and docker modes); needs the BPF and PERFMON capabilities")
	httpStats := fs.Bool("ebpf-http", envOr("WATCHLOG_EBPF_HTTP", "true") != "false",
		"HTTP/1.x requests, status codes and latency on network edges (ADR-139): a 16-byte peek, no paths or bodies")
	podFilter := fs.Bool("ebpf-pod-filter", envOr("WATCHLOG_EBPF_POD_FILTER", "true") != "false",
		"node mode: record only this node's pods in the kernel (ADR-121); false records every task and drops the rest in user space")
	scopeFlag := fs.String("node-metrics-scope", envOr("WATCHLOG_NODE_METRICS_SCOPE", host.ScopeAuto),
		"node metrics from the host's /proc (host), the node's own cgroup when the node is a container on a shared kernel (cgroup), or detected (auto)")
	healthOutput := fs.Bool("health-output", envOr("WATCHLOG_HEALTH_OUTPUT", "true") != "false",
		"send health probe output (redacted, one line, at most 512 bytes); false sends exit codes only")
	logsOn := fs.Bool("logs", envOr("WATCHLOG_LOGS", "true") != "false",
		"docker mode: read a container's last log lines when someone asks (ADR-167); false never reads logs")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	if *showVersion {
		if _, err := fmt.Fprintln(stdout, version.String()); err != nil {
			return 1
		}
		return 0
	}
	mode, err := config.ParseMode(*modeFlag)
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		return 2
	}
	if *output != "text" {
		slog.Error("invalid configuration", "err", fmt.Errorf("unsupported --output %q", *output))
		return 2
	}
	if *hostname == "" {
		*hostname = config.Hostname(paths)
	}

	hostCfg := host.Config{ProcRoot: paths.Proc, SysRoot: paths.Sys, RootFS: paths.RootFS, Log: slog.Default()}
	scope, err := host.ParseScope(*scopeFlag)
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		return 2
	}
	hostCfg.Scope, err = resolveScope(scope, mode, hostCfg, paths)
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		return 2
	}
	collector := host.New(hostCfg)
	sources := []runner.Source{{Name: "host", Collect: collector.Collect}}
	var kubelet *kubepods.Kubelet
	var podmapClient *podmap.Client
	if mode == config.ModeNode {
		var err error
		if kubelet, err = kubepods.NewKubelet(*kubeletURL, saDir+"/ca.crt", saDir+"/token", *kubeletTLS, slog.Default()); err != nil {
			slog.Warn("kubelet summary disabled", "err", err)
			kubelet = nil
		}
		var maps kubepods.Maps = noMaps{}
		if *podmapURL != "" {
			client, err := podmap.NewClient(*podmapURL, *podmapCA, *podmapToken, podmap.CacheFileIn(*bufferDir))
			if err != nil {
				slog.Warn("pod map disabled; container series stay unlabelled and are dropped", "err", err)
			} else {
				maps, podmapClient = client, client
			}
		}
		var summary kubepods.Summary
		if kubelet != nil {
			summary = kubelet
		}
		pods := kubepods.New(containers.NewReader(paths.Proc, paths.Sys), maps, summary, slog.Default())
		sources = append(sources, runner.Source{Name: "pods", Collect: pods.Collect})
	}
	var dockerCollector *runtime.Collector
	var dockerClient *docker.Client
	if mode == config.ModeDocker {
		dockerClient = docker.New(*dockerSocket)
		dockerClient.LogsEnabled = *logsOn
		dockerCollector = runtime.New(dockerClient, containers.NewReader(paths.Proc, paths.Sys), slog.Default())
		dockerCollector.HealthOutput = *healthOutput
		dockerCollector.Host = *hostname
		sources = append(sources, runner.Source{Name: "docker", Collect: dockerCollector.Collect})
	}
	ebpfState := network.Disabled
	var netCollector *network.Collector
	if mode != config.ModeCluster && *ebpfFlag {
		// Unsupported or not permitted: reported in the heartbeat, everything else runs.
		var flows *ebpf.Flows
		flows, ebpfState = network.Start(paths.Sys, *httpStats, slog.Default())
		if flows != nil {
			defer flows.Close()
			reader := containers.NewReader(paths.Proc, paths.Sys)
			owners := func() (map[uint64]network.Owner, error) { return network.PodCgroups(reader, network.Inode) }
			if mode == config.ModeDocker {
				owners = func() (map[uint64]network.Owner, error) {
					if dockerCollector == nil {
						return nil, nil
					}
					return network.DockerCgroups(reader, dockerCollector.ContainerIDs(), network.Inode), nil
				}
			}
			netCollector = network.New(flows, owners, slog.Default())
			netCollector.Bytes = flows.Bytes
			if mode == config.ModeNode && *podFilter {
				netCollector.PodFilter = network.NewPodFilter(flows, func() []uint64 { return kubepodsRoots(reader) }, slog.Default())
				netCollector.PodFilter.Refresh()
			}
			if flows.DNS {
				names := network.NewNames()
				netCollector.DNSNames = names
				// The agent's own search list is the one its node gives every pod (ADR-113).
				search := network.SearchDomains("/etc/resolv.conf")
				misses := network.NewSearchMisses(search)
				netCollector.SearchMisses = misses
				netCollector.ClusterDomain = network.ClusterDomain(search)
				go func() {
					err := flows.ReadDNSResponses(func(cgroup uint64, msg []byte) {
						names.Add(cgroup, msg)
						if misses != nil {
							misses.Add(cgroup, msg)
						}
					})
					if err != nil {
						slog.Warn("DNS responses for names and search-path misses stopped", "err", err)
					}
				}()
			}
			switch {
			case mode == config.ModeDocker && dockerCollector != nil:
				netCollector.Names = network.DockerNames(dockerCollector.Identities)
				netCollector.Resolver = network.DockerResolver(dockerCollector.Identities)
			case podmapClient != nil:
				netCollector.Names = network.KubeNames(podmapClient.Last)
				netCollector.Resolver = network.KubeResolver(podmapClient.FetchIPMap, *interval, slog.Default())
			}
		}
	}
	if netCollector != nil {
		sources = append(sources, runner.Source{Name: "network", Collect: netCollector.Collect})
	}

	if *once {
		var samples []metrics.Sample
		for _, src := range sources {
			s, err := src.Collect()
			if err != nil {
				slog.Warn("some metrics could not be collected", "collector", src.Name, "err", err)
			}
			samples = append(samples, s...)
		}
		hostLabel := metrics.Label{Name: "host", Value: *hostname}
		for i := range samples {
			samples[i] = samples[i].WithLabels(hostLabel)
		}
		if err := metrics.WriteText(stdout, samples, time.Now()); err != nil {
			slog.Error("write output", "err", err)
			return 1
		}
		return 0
	}

	if mode == config.ModeCluster {
		slog.Error("cluster mode is a separate binary and image: run watchlog-cluster-agent (ADR-048)")
		return 2
	}
	token := os.Getenv("WATCHLOG_TOKEN")
	if token == "" || *endpoint == "" {
		slog.Error("WATCHLOG_TOKEN and WATCHLOG_ENDPOINT are required (see Settings → Clusters for the install command)")
		return 2
	}
	base, err := url.Parse(strings.TrimRight(*endpoint, "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		slog.Error("invalid WATCHLOG_ENDPOINT; expected http(s)://host[:port]")
		return 2
	}
	if *interval < time.Second {
		slog.Error("invalid --interval; must be at least 1s")
		return 2
	}

	buf, err := buffer.Open(*bufferDir, bufferMaxBytes, bufferMaxAge)
	if err != nil {
		slog.Error("cannot open the buffer directory; mount a writable volume at /var/lib/watchlog-agent", "err", err)
		return 1
	}
	log := slog.Default()
	snd := sender.New(sender.Config{
		WriteURL:     base.String() + "/ingest/v1/write",
		HeartbeatURL: base.String() + "/ingest/v1/heartbeat",
		ObjectsURL:   base.String() + "/ingest/v1/objects",
		EventsURL:    base.String() + "/ingest/v1/events",
		Token:        token,
		AgentID:      *hostname,
		UserAgent:    "watchlog-agent/" + version.Version,
	}, buf, log)
	r := &runner.Runner{
		Mode:      string(mode),
		Version:   version.Version,
		Host:      *hostname,
		HostLabel: map[config.Mode]string{config.ModeNode: "node", config.ModeDocker: "host"}[mode],
		Interval:  *interval,
		SeriesCap: runner.DefaultSeriesCap,
		Sources:   sources,
		Buffer:    buf,
		Sender:    snd,
		Log:       log,
		Capabilities: sender.Capabilities{
			EBPF:        ebpfState.State,
			EBPFReason:  ebpfState.Reason,
			EBPFCause:   ebpfState.Cause,
			Cgroup:      config.CgroupVersion(paths),
			HelmRelease: helmRelease(os.Getenv("WATCHLOG_HELM_RELEASE")),
			HelmChart:   helmRelease(os.Getenv("WATCHLOG_HELM_CHART")),
			ContainerID: selfContainerID(mode),
			NodeScope:   hostCfg.Scope,
			Logs:        logsCapability(mode, *logsOn),
		},
	}

	if kubelet != nil || hostCfg.Scope == host.ScopeCgroup {
		caps := r.Capabilities
		r.CapabilitiesFunc = func() sender.Capabilities {
			c := caps
			if kubelet != nil {
				c.KubeletTLS = kubelet.TLS()
			}
			// The node's capacity is its cgroup's limits, not the host's (ADR-121).
			if cores, mem, ok := collector.Capacity(); ok {
				c.NodeCPUCores, c.NodeMemoryBytes = cores, mem
			}
			return c
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if dockerCollector != nil {
		r.Inventory = func() (any, string) { return dockerCollector.Inventory() }
		r.Changes = dockerCollector.Changes()
		r.Delta = func(ctx context.Context) (any, error) {
			inv, err := dockerCollector.Delta(ctx)
			if inv == nil {
				return nil, err // not a typed nil in an interface
			}
			return inv, err
		}
		go dockerCollector.WatchEvents(ctx)
		go dockerCollector.ShipEvents(ctx, snd.SendEvents, log)
		if *logsOn {
			lr := &logs.Runner{Base: base.String(), Token: token, AgentID: *hostname, Host: *hostname,
				UserAgent: "watchlog-agent/" + version.Version, Reader: logs.DockerReader{API: dockerClient}, Log: log}
			go lr.Run(ctx)
		}
	}
	if podmapClient != nil && netCollector != nil {
		// The cluster-agent pushes IP map changes; flows resolve against them at the next
		// drain instead of a map up to an interval old (ADR-116).
		go func() { _ = podmapClient.WatchIPMap(ctx, slog.Default()) }()
	}
	slog.Info("agent started", "mode", mode, "version", version.Version, "host", *hostname,
		"endpoint", base.String(), "interval", *interval, "health_output", *healthOutput)
	r.Run(ctx)
	slog.Info("agent stopped; undelivered batches stay buffered")
	return 0
}

// logsCapability is "on" or "off" for a Docker agent (ADR-167); node agents read no logs.
func logsCapability(mode config.Mode, on bool) string {
	switch {
	case mode != config.ModeDocker:
		return ""
	case on:
		return "on"
	}
	return "off"
}

// resolveScope turns auto into host or cgroup. Auto detects only in node mode; a
// Docker host is the host unless cgroup is asked for. cgroup needs cgroup v2.
func resolveScope(scope string, mode config.Mode, cfg host.Config, paths config.HostPaths) (string, error) {
	if scope == host.ScopeAuto {
		if mode != config.ModeNode {
			return host.ScopeHost, nil
		}
		var why string
		scope, why = host.DetectScope(cfg)
		slog.Info("node metrics scope detected", "scope", scope, "signal", why)
	}
	if scope == host.ScopeCgroup && config.CgroupVersion(paths) != "v2" {
		if mode == config.ModeNode {
			slog.Warn("node metrics scope cgroup needs cgroup v2; reading the host's /proc")
			return host.ScopeHost, nil
		}
		return "", fmt.Errorf("node metrics scope cgroup needs cgroup v2")
	}
	return scope, nil
}

// kubepodsRoots are the cgroup ids of the node's kubepods cgroups, the pod filter's
// roots (ADR-121).
func kubepodsRoots(r *containers.Reader) []uint64 {
	var ids []uint64
	for _, dir := range r.KubepodsRoots() {
		if id, ok := network.Inode(dir); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// kubeletDefault is the node's own kubelet, from the downward API's status.hostIP.
func kubeletDefault() string {
	if ip := os.Getenv("HOST_IP"); ip != "" {
		return "https://" + net.JoinHostPort(ip, "10250") + "/stats/summary"
	}
	return ""
}

// noMaps stands in when no pod map is configured: every container stays unmapped.
type noMaps struct{}

func (noMaps) Last() *podmap.Map { return nil }
func (noMaps) Fetch(context.Context) (*podmap.Map, error) {
	return nil, fmt.Errorf("no pod map configured (WATCHLOG_PODMAP_URL)")
}
