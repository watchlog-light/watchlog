// SPDX-License-Identifier: AGPL-3.0-only

// Command watchlog-integrations reads the services WatchLog monitors next to the
// workloads (Redis, PostgreSQL, Nginx, …) with read-only access, and pushes their
// metrics and status to WatchLog (SPEC §4.12, ADR-131). One runs per Kubernetes
// cluster, and one per Docker host that runs a monitored service.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/buffer"
	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/runner"
	"github.com/watchlog-light/watchlog/agent/internal/sender"
	"github.com/watchlog-light/watchlog/agent/internal/version"
)

// Buffer limits: smaller than the agent's, the collector's data is less critical
// and its directory is often a tmpfs.
const (
	bufferMaxBytes = 64 << 20
	bufferMaxAge   = 15 * time.Minute
)

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}

// defaultMode is kubernetes inside a pod, docker elsewhere.
func defaultMode() string {
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		return "kubernetes"
	}
	return "docker"
}

func run(args []string, stdout io.Writer) int {
	version.Name = "watchlog-integrations"
	fs := flag.NewFlagSet("watchlog-integrations", flag.ContinueOnError)
	showVersion := fs.Bool("version", false, "print version and exit")
	mode := fs.String("mode", envOr("WATCHLOG_COLLECTOR_MODE", defaultMode()), "kubernetes or docker")
	endpoint := fs.String("endpoint", os.Getenv("WATCHLOG_ENDPOINT"), "WatchLog base URL, e.g. https://watchlog.example.com")
	host := fs.String("hostname", os.Getenv("WATCHLOG_HOSTNAME"),
		"docker mode: this host's name as WatchLog knows it (default: the machine's host name)")
	bufferDir := fs.String("buffer-dir", envOr("WATCHLOG_BUFFER_DIR", "/var/lib/watchlog-integrations/buffer"), "on-disk buffer directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		if _, err := fmt.Fprintln(stdout, version.String()); err != nil {
			return 1
		}
		return 0
	}
	switch *mode {
	case "kubernetes":
		// One collector per cluster: it reports with an empty host.
		*host = ""
	case "docker":
		if *host == "" {
			*host, _ = os.Hostname()
		}
		if *host == "" {
			slog.Error("set WATCHLOG_HOSTNAME to this host's name as WatchLog shows it")
			return 2
		}
	default:
		slog.Error("invalid configuration", "err", fmt.Errorf("unsupported --mode %q: kubernetes or docker", *mode))
		return 2
	}
	token := os.Getenv("WATCHLOG_TOKEN")
	if token == "" || *endpoint == "" {
		slog.Error("WATCHLOG_TOKEN and WATCHLOG_ENDPOINT are required (the cluster's token and WatchLog's address)")
		return 2
	}
	base, err := url.Parse(strings.TrimRight(*endpoint, "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		slog.Error("invalid WATCHLOG_ENDPOINT; expected http(s)://host[:port]")
		return 2
	}
	buf, err := buffer.Open(*bufferDir, bufferMaxBytes, bufferMaxAge)
	if err != nil {
		slog.Error("cannot open the buffer directory; mount a writable volume or tmpfs at /var/lib/watchlog-integrations", "err", err)
		return 1
	}

	agentID := "integrations"
	if *host != "" {
		agentID += ":" + *host
	}
	userAgent := "watchlog-integrations/" + version.Version
	log := slog.Default()
	snd := sender.New(sender.Config{
		WriteURL:     base.String() + "/ingest/v1/write",
		HeartbeatURL: base.String() + "/ingest/v1/integrations/status",
		Token:        token,
		AgentID:      agentID,
		UserAgent:    userAgent,
	}, buf, log)
	c := &integrations.Collector{
		Mode:    *mode,
		Host:    *host,
		Version: version.Version,
		Config: &integrations.ConfigClient{
			URL:       base.String() + "/ingest/v1/integrations/config",
			Token:     token,
			Host:      *host,
			AgentID:   agentID,
			UserAgent: userAgent,
		},
		Registry: integrations.Registry{},
		Buffer:   buf,
		Sender:   snd,
		Log:      log,
		Self:     runner.SelfUsage,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	slog.Info("integrations collector started", "mode", *mode, "host", *host, "version", version.Version,
		"endpoint", base.String())
	c.Run(ctx)
	slog.Info("integrations collector stopped; undelivered batches stay buffered")
	return 0
}
