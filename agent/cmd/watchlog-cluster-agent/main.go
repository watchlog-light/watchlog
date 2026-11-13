// SPDX-License-Identifier: AGPL-3.0-only

// Command watchlog-cluster-agent watches the Kubernetes API and ships objects,
// events and state metrics (SPEC §6.5). It is a separate binary from the node
// agent so that only it links client-go (ADR-048).
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/k8s"
	"github.com/watchlog-light/watchlog/agent/internal/logs"
	"github.com/watchlog-light/watchlog/agent/internal/podmap"
	"github.com/watchlog-light/watchlog/agent/internal/runner"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
	"github.com/watchlog-light/watchlog/agent/internal/version"
)

// Buffer limits as for the node agent (SPEC §5.2, ADR-022).
const (
	bufferMaxBytes = 200 << 20
	bufferMaxAge   = 15 * time.Minute
	leaseName      = "watchlog-cluster-agent"
	// AgentID is the cluster-agent's identity in heartbeats and rate limits.
	agentID = "cluster-agent"
)

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	version.Name = "watchlog-cluster-agent"
	os.Exit(run(os.Args[1:], os.Stdout))
}

func run(args []string, stdout io.Writer) int {
	fs := flag.NewFlagSet("watchlog-cluster-agent", flag.ContinueOnError)
	showVersion := fs.Bool("version", false, "print version and exit")
	endpoint := fs.String("endpoint", os.Getenv("WATCHLOG_ENDPOINT"), "WatchLog base URL")
	bufferDir := fs.String("buffer-dir", envOr("WATCHLOG_BUFFER_DIR", "/var/lib/watchlog-agent/buffer"), "on-disk buffer directory")
	interval := fs.Duration("interval", 15*time.Second, "metrics interval")
	kubeconfig := fs.String("kubeconfig", os.Getenv("KUBECONFIG"), "kubeconfig file (default: in-cluster ServiceAccount)")
	leaderElect := fs.Bool("leader-elect", true, "run only while holding the Lease (ADR-054)")
	namespace := fs.String("lease-namespace", envOr("POD_NAMESPACE", "watchlog"), "namespace of the leader-election Lease")
	hostname, _ := os.Hostname()
	identity := fs.String("identity", envOr("POD_NAME", hostname), "leader-election identity")
	podmapAddr := fs.String("podmap-addr", ":8443", "listen address of the node agents' pod map (HTTPS, ADR-066)")
	podmapCert := fs.String("podmap-cert", os.Getenv("WATCHLOG_PODMAP_CERT"), "TLS certificate for the pod map (empty: pod map disabled)")
	podmapKey := fs.String("podmap-key", os.Getenv("WATCHLOG_PODMAP_KEY"), "TLS key for the pod map")
	nodeAgentSA := fs.String("node-agent-serviceaccount", envOr("WATCHLOG_NODE_AGENT_SA", "watchlog-agent"),
		"ServiceAccount of the node agents, in the lease namespace; the only identity the pod map answers")
	logsOn := fs.Bool("logs", envOr("WATCHLOG_LOGS", "true") != "false",
		"read a container's last log lines when someone asks (pods/log, ADR-167); false never reads logs")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		if _, err := fmt.Fprintln(stdout, version.String()); err != nil {
			return 1
		}
		return 0
	}
	log := slog.Default()
	token := os.Getenv("WATCHLOG_TOKEN")
	base, err := url.Parse(strings.TrimRight(*endpoint, "/"))
	if token == "" || err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		log.Error("WATCHLOG_TOKEN and WATCHLOG_ENDPOINT (http(s)://host[:port]) are required")
		return 2
	}

	cfg, err := restConfig(*kubeconfig)
	if err != nil {
		log.Error("cannot load Kubernetes credentials", "err", err)
		return 1
	}
	cfg.UserAgent = "watchlog-cluster-agent/" + version.Version
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Error("cannot create the Kubernetes client", "err", err)
		return 1
	}
	buf, err := buffer.Open(*bufferDir, bufferMaxBytes, bufferMaxAge)
	if err != nil {
		log.Error("cannot open the buffer directory", "err", err)
		return 1
	}
	snd := sender.New(sender.Config{
		WriteURL:     base.String() + "/ingest/v1/write",
		HeartbeatURL: base.String() + "/ingest/v1/heartbeat",
		ObjectsURL:   base.String() + "/ingest/v1/objects",
		EventsURL:    base.String() + "/ingest/v1/events",
		Token:        token, AgentID: agentID, UserAgent: "watchlog-cluster-agent/" + version.Version,
	}, buf, log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Every replica watches the API and serves the pod map, so a synced standby is
	// ready and takes over within one retry period (ADR-068). Only the Lease holder
	// ships objects, events and metrics.
	cluster, err := k8s.NewCluster(cs, 0, true)
	if err != nil {
		log.Error("cannot create informers", "err", err)
		return 1
	}
	started := time.Now()
	if !cluster.Start(ctx) {
		return 0 // stopped before the caches filled
	}
	log.Info("caches synced", "after", time.Since(started).Round(time.Millisecond))
	pm := &k8s.PodMapServer{Cluster: cluster, Reviews: cs.AuthenticationV1().TokenReviews(),
		Namespace: *namespace, Account: *nodeAgentSA, Log: log}
	// Push IP map changes to the node agents' watches (ADR-116); without it they poll.
	if err := pm.Run(ctx); err != nil {
		log.Warn("ip map changes are not pushed; node agents poll", "err", err)
	}
	servePodMap(ctx, log, *podmapAddr, *podmapCert, *podmapKey, pm)

	lead := func(ctx context.Context) {
		log.Info("leading: shipping objects, events and state metrics", "identity", *identity)
		shipper, err := k8s.NewShipper(cluster, snd.SendObjects, log)
		if err != nil {
			log.Error("cannot watch objects", "err", err)
			return
		}
		events, err := k8s.NewEventShipper(cluster, snd.SendEvents, log)
		if err != nil {
			log.Error("cannot watch events", "err", err)
			return
		}
		r := &runner.Runner{Mode: "cluster", Version: version.Version, Host: agentID, Interval: *interval,
			SeriesCap: k8s.StateSeriesCap, Sources: cluster.StateSources(), Buffer: buf, Sender: snd, Log: log,
			Capabilities: sender.Capabilities{EBPF: "disabled", Cgroup: "none", Logs: onOff(*logsOn)}}
		go shipper.Run(ctx)
		go events.Run(ctx)
		if *logsOn {
			// Only the leader answers log requests, like everything it ships.
			lr := &logs.Runner{Base: base.String(), Token: token, AgentID: agentID,
				UserAgent: "watchlog-cluster-agent/" + version.Version,
				Reader:    k8s.LogReader{Client: cs}, Log: log}
			go lr.Run(ctx)
		}
		r.Run(ctx)
	}

	log.Info("cluster-agent started", "version", version.Version, "endpoint", base.String(), "leader_elect", *leaderElect, "logs", onOff(*logsOn))
	if !*leaderElect {
		lead(ctx)
		return 0
	}
	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock: &resourcelock.LeaseLock{
			LeaseMeta:  metaFor(leaseName, *namespace),
			Client:     cs.CoordinationV1(),
			LockConfig: resourcelock.ResourceLockConfig{Identity: *identity},
		},
		LeaseDuration: 15 * time.Second, RenewDeadline: 10 * time.Second, RetryPeriod: 2 * time.Second,
		ReleaseOnCancel: true, Name: leaseName,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: lead,
			OnStoppedLeading: func() { log.Info("leadership ended", "identity", *identity) },
		},
	})
	if ctx.Err() == nil {
		log.Error("lost the leader-election Lease; exiting so another replica takes over")
		return 1
	}
	return 0
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func restConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig != "" {
		return clientcmd.BuildConfigFromFlags("", kubeconfig)
	}
	cfg, err := rest.InClusterConfig()
	if errors.Is(err, rest.ErrNotInCluster) {
		return nil, errors.New("not in a cluster: set --kubeconfig or KUBECONFIG")
	}
	return cfg, err
}

// servePodMap serves the node agents' pod map over HTTPS until ctx ends (ADR-066).
func servePodMap(ctx context.Context, log *slog.Logger, addr, certFile, keyFile string, h http.Handler) {
	if certFile == "" || keyFile == "" {
		log.Warn("pod map disabled: no TLS certificate configured; node agents keep their cached map")
		return
	}
	mux := http.NewServeMux()
	mux.Handle(podmap.Path, h)
	mux.Handle(podmap.IPMapPath, h) // cluster-wide address map (ADR-101)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	go func() {
		if err := srv.ListenAndServeTLS(certFile, keyFile); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("pod map server stopped", "err", err)
		}
	}()
	go func() {
		<-ctx.Done()
		// ctx is already cancelled here; keep its values, not its cancellation.
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Info("pod map serving", "addr", addr)
}
