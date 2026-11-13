// SPDX-License-Identifier: AGPL-3.0-only

// Package docker is a read-only Docker Engine API client restricted to an
// allowlist of GET requests (ADR-024). It decodes only the fields WatchLog
// uses; container environment variables are never decoded or kept.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MaxAPIVersion is the newest API version the client was tested against (Docker 29.9).
const MaxAPIVersion = "1.56"

// ErrNotAllowed is returned for any request outside the allowlist; no request is made.
var ErrNotAllowed = errors.New("docker API request not allowed")

var allowedPaths = []*regexp.Regexp{
	regexp.MustCompile(`^/_ping$`),
	regexp.MustCompile(`^/version$`),
	regexp.MustCompile(`^/v1\.\d+/containers/json$`),
	regexp.MustCompile(`^/v1\.\d+/containers/[a-f0-9]{12,64}/json$`),
	regexp.MustCompile(`^/v1\.\d+/containers/[a-f0-9]{12,64}/stats$`),
	regexp.MustCompile(`^/v1\.\d+/events$`),
	// Logs on demand (ADR-167): read only when someone asks, and only while the agent's
	// WATCHLOG_LOGS is on (Client.Logs refuses otherwise).
	regexp.MustCompile(`^/v1\.\d+/containers/[a-f0-9]{12,64}/logs$`),
}

// Allowed reports whether a request may be sent (GET on an allowlisted path).
func Allowed(method, path string) bool {
	if method != http.MethodGet {
		return false
	}
	for _, re := range allowedPaths {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}

// Client talks to the Docker Engine API over a unix socket.
type Client struct {
	http       *http.Client
	apiVersion string
	// LogsEnabled allows Logs (WATCHLOG_LOGS, ADR-167); off, no logs request is made.
	LogsEnabled bool
}

// ErrLogsOff is returned by Logs when logs on demand are turned off.
var ErrLogsOff = errors.New("container logs are turned off on this agent (WATCHLOG_LOGS=false)")

// Logs opens a container's log: the last tail lines with timestamps, stdout and stderr,
// and new lines too with follow. The stream is multiplexed (8-byte frame headers) unless
// the container has a TTY. The caller closes it.
func (c *Client) Logs(ctx context.Context, id string, tail int, follow bool) (io.ReadCloser, error) {
	if !c.LogsEnabled {
		return nil, ErrLogsOff
	}
	q := url.Values{"stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"}, "tail": {strconv.Itoa(tail)}}
	if follow {
		q.Set("follow", "1")
	}
	res, err := c.get(ctx, c.versioned("/containers/"+id+"/logs"), q)
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

// New returns a client for the socket at path (normally /var/run/docker.sock).
func New(socketPath string) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:    4,
		IdleConnTimeout: 90 * time.Second,
	}
	return &Client{http: &http.Client{Transport: tr}, apiVersion: MaxAPIVersion}
}

func (c *Client) get(ctx context.Context, path string, query url.Values) (*http.Response, error) {
	if !Allowed(http.MethodGet, path) {
		return nil, fmt.Errorf("%w: GET %s", ErrNotAllowed, path)
	}
	u := url.URL{Scheme: "http", Host: "docker", Path: path, RawQuery: query.Encode()}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		_ = res.Body.Close()
		return nil, &StatusError{Code: res.StatusCode, Message: strings.TrimSpace(string(b))}
	}
	return res, nil
}

// StatusError is a non-200 response from the daemon.
type StatusError struct {
	Code    int
	Message string
}

func (e *StatusError) Error() string { return fmt.Sprintf("docker API %d: %s", e.Code, e.Message) }

func (c *Client) getJSON(ctx context.Context, path string, query url.Values, into any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := c.get(ctx, path, query)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	return json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(into)
}

func (c *Client) versioned(path string) string { return "/v" + c.apiVersion + path }

// Version describes the daemon (the hosts list shows Docker and kernel versions, SPEC §4.4).
type Version struct {
	Version       string `json:"Version"`
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
	Os            string `json:"Os"`
	Arch          string `json:"Arch"`
	KernelVersion string `json:"KernelVersion"`
}

// Negotiate reads the daemon version and picks the API version to use:
// the daemon's own, capped at MaxAPIVersion.
func (c *Client) Negotiate(ctx context.Context) (Version, error) {
	var v Version
	if err := c.getJSON(ctx, "/version", nil, &v); err != nil {
		return v, err
	}
	c.apiVersion = minVersion(v.APIVersion, MaxAPIVersion)
	return v, nil
}

func minVersion(a, b string) string {
	parse := func(s string) (int, int) {
		major, minor, _ := strings.Cut(s, ".")
		x, _ := strconv.Atoi(major)
		y, _ := strconv.Atoi(minor)
		return x, y
	}
	if a == "" {
		return b
	}
	ax, ay := parse(a)
	bx, by := parse(b)
	if ax < bx || (ax == bx && ay < by) {
		return a
	}
	return b
}

// APIVersion is the negotiated version.
func (c *Client) APIVersion() string { return c.apiVersion }

// Port is a container port mapping from the list endpoint.
type Port struct {
	IP          string `json:"IP"`
	PrivatePort uint16 `json:"PrivatePort"`
	PublicPort  uint16 `json:"PublicPort"`
	Type        string `json:"Type"`
}

// ContainerSummary is one entry of GET /containers/json (fields used by WatchLog only).
type ContainerSummary struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	Created int64             `json:"Created"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
	Ports   []Port            `json:"Ports"`
	SizeRw  *int64            `json:"SizeRw"`
	Health  *struct {
		Status        string `json:"Status"`
		FailingStreak int    `json:"FailingStreak"`
	} `json:"Health"`
	HostConfig struct {
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
	// NetworkSettings gives the container's address on each network (eBPF flow
	// destinations, ADR-102; shape measured on Docker 29).
	NetworkSettings struct {
		Networks map[string]struct {
			IPAddress         string `json:"IPAddress"`
			GlobalIPv6Address string `json:"GlobalIPv6Address"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

// Name is the container name without the leading slash.
func (s ContainerSummary) Name() string {
	if len(s.Names) == 0 {
		return s.ID[:min(12, len(s.ID))]
	}
	return strings.TrimPrefix(s.Names[0], "/")
}

// ListContainers lists all containers; withSize adds SizeRw (expensive, use sparingly).
func (c *Client) ListContainers(ctx context.Context, withSize bool) ([]ContainerSummary, error) {
	q := url.Values{"all": {"1"}}
	if withSize {
		q.Set("size", "1")
	}
	var out []ContainerSummary
	err := c.getJSON(ctx, c.versioned("/containers/json"), q, &out)
	return out, err
}

// ContainerState holds the inspect fields WatchLog uses. The inspect response
// also contains Config.Env and Config.Cmd; they are deliberately absent here and
// never decoded. Health check commands and probe output are redacted by the
// caller before they leave the host (ADR-047).
type ContainerState struct {
	ID           string `json:"Id"`
	RestartCount int    `json:"RestartCount"`
	State        struct {
		Status     string  `json:"Status"`
		Running    bool    `json:"Running"`
		Restarting bool    `json:"Restarting"`
		OOMKilled  bool    `json:"OOMKilled"`
		Pid        int     `json:"Pid"`
		ExitCode   int     `json:"ExitCode"`
		Error      string  `json:"Error"`
		StartedAt  string  `json:"StartedAt"`
		FinishedAt string  `json:"FinishedAt"`
		Health     *Health `json:"Health"`
	} `json:"State"`
	Config struct {
		Healthcheck *Healthcheck `json:"Healthcheck"`
	} `json:"Config"`
}

// Health is State.Health: the daemon keeps the last five probe results in Log.
type Health struct {
	Status        string        `json:"Status"`
	FailingStreak int           `json:"FailingStreak"`
	Log           []HealthProbe `json:"Log"`
}

// HealthProbe is one health check run.
type HealthProbe struct {
	Start    string `json:"Start"`
	End      string `json:"End"`
	ExitCode int    `json:"ExitCode"`
	Output   string `json:"Output"`
}

// Healthcheck is Config.Healthcheck. Durations are nanoseconds; 0 means the daemon default.
type Healthcheck struct {
	Test        []string `json:"Test"`
	Interval    int64    `json:"Interval"`
	Timeout     int64    `json:"Timeout"`
	StartPeriod int64    `json:"StartPeriod"`
	Retries     int      `json:"Retries"`
}

// Inspect reads a container's state (restart count, PID, exit code, OOM flag, health).
func (c *Client) Inspect(ctx context.Context, id string) (ContainerState, error) {
	var out ContainerState
	err := c.getJSON(ctx, c.versioned("/containers/"+id+"/json"), nil, &out)
	return out, err
}

// Event is a container event (only the fields WatchLog uses).
type Event struct {
	Type   string `json:"Type"`
	Action string `json:"Action"`
	Actor  struct {
		ID         string            `json:"ID"`
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
	TimeNano int64 `json:"timeNano"`
}

// EventActions are the container and image events WatchLog listens to. Healthcheck
// exec_* events fire every few seconds (measured) and are filtered out by the daemon.
var EventActions = []string{"create", "start", "die", "oom", "restart", "destroy", "health_status", "pull"}

// Events streams container events until ctx is cancelled or the stream ends.
func (c *Client) Events(ctx context.Context, since time.Time, fn func(Event)) error {
	filters, _ := json.Marshal(map[string][]string{"type": {"container", "image"}, "event": EventActions})
	q := url.Values{"filters": {string(filters)}}
	if !since.IsZero() {
		q.Set("since", strconv.FormatInt(since.Unix(), 10))
	}
	res, err := c.get(ctx, c.versioned("/events"), q)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	return decodeEvents(res.Body, fn)
}

// decodeEvents reads a stream of JSON objects (newline-delimited in practice).
func decodeEvents(r io.Reader, fn func(Event)) error {
	dec := json.NewDecoder(r)
	for {
		var e Event
		if err := dec.Decode(&e); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		fn(e)
	}
}
