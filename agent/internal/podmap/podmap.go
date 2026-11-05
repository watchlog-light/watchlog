// SPDX-License-Identifier: AGPL-3.0-only

// Package podmap is the node-scoped pod map the cluster-agent serves to node agents
// (ADR-049, ADR-066): pod ID → namespace, pod and workload; container ID → name.
// It has no client-go dependency so the node agent stays small (ADR-048).
package podmap

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Audience of the projected ServiceAccount token node agents present (ADR-066).
const Audience = "watchlog-cluster-agent"

// Path of the endpoint on the cluster-agent.
const Path = "/v1/podmap"

// Pod is one pod on the node.
type Pod struct {
	// ID is the pod UID; for a static pod Mirror is its kubelet config hash,
	// which is what the node's cgroup paths carry (ADR-050).
	ID           string            `json:"id"`
	Mirror       string            `json:"mirror,omitempty"`
	Namespace    string            `json:"namespace"`
	Name         string            `json:"name"`
	WorkloadKind string            `json:"workload_kind"`
	Workload     string            `json:"workload"`
	Containers   map[string]string `json:"containers"` // container ID (no runtime prefix) → name
}

// Map is the pod map of one node.
type Map struct {
	Node string `json:"node"`
	Pods []Pod  `json:"pods"`
}

// Index looks pods up by UID or static pod hash.
type Index map[string]*Pod

// Index builds the lookup table.
func (m *Map) Index() Index {
	idx := make(Index, len(m.Pods)*2)
	for i := range m.Pods {
		p := &m.Pods[i]
		idx[p.ID] = p
		if p.Mirror != "" {
			idx[p.Mirror] = p
		}
	}
	return idx
}

// ContainerID strips the runtime prefix ("containerd://", "cri-o://", "docker://").
func ContainerID(s string) string {
	if _, id, ok := strings.Cut(s, "://"); ok {
		return id
	}
	return s
}

// Client fetches the map from the cluster-agent and keeps the last one on disk.
type Client struct {
	URL       string // e.g. https://watchlog-cluster-agent.watchlog.svc:8443
	TokenFile string // projected token (rotated by the kubelet; re-read every request)
	CacheFile string // last map, used across restarts and outages
	HTTP      *http.Client

	mu   sync.Mutex
	etag string
	last *Map

	ipETag string
	ipLast *IPMap
}

// NewClient builds a client that trusts only caFile for the cluster-agent's certificate.
func NewClient(url, caFile, tokenFile, cacheFile string) (*Client, error) {
	pem, err := os.ReadFile(caFile) //nolint:gosec // path from configuration
	if err != nil {
		return nil, fmt.Errorf("pod map CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("pod map CA: no certificate found")
	}
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	c := &Client{URL: strings.TrimRight(url, "/"), TokenFile: tokenFile, CacheFile: cacheFile,
		HTTP: &http.Client{Transport: tr, Timeout: 10 * time.Second}}
	c.loadCache()
	return c, nil
}

func (c *Client) loadCache() {
	if c.CacheFile == "" {
		return
	}
	b, err := os.ReadFile(c.CacheFile)
	if err != nil {
		return
	}
	var m Map
	if json.Unmarshal(b, &m) == nil {
		c.last = &m
	}
}

// Last returns the most recent map (from the cluster-agent or the disk cache), or nil.
func (c *Client) Last() *Map {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

// Fetch asks the cluster-agent for this node's map. On failure the previous map
// stays in use; the error is returned for logging.
func (c *Client) Fetch(ctx context.Context) (*Map, error) {
	token, err := os.ReadFile(c.TokenFile) //nolint:gosec // path from configuration
	if err != nil {
		return c.Last(), fmt.Errorf("pod map token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+Path, nil)
	if err != nil {
		return c.Last(), err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	c.mu.Lock()
	if c.etag != "" && c.last != nil {
		req.Header.Set("If-None-Match", c.etag)
	}
	c.mu.Unlock()
	res, err := c.HTTP.Do(req)
	if err != nil {
		return c.Last(), err
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case http.StatusNotModified:
		return c.Last(), nil
	case http.StatusOK:
	default:
		b, _ := io.ReadAll(io.LimitReader(res.Body, 256))
		return c.Last(), fmt.Errorf("pod map: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return c.Last(), err
	}
	var m Map
	if err := json.Unmarshal(b, &m); err != nil {
		return c.Last(), fmt.Errorf("pod map: %w", err)
	}
	c.mu.Lock()
	c.last, c.etag = &m, res.Header.Get("ETag")
	c.mu.Unlock()
	if c.CacheFile != "" {
		tmp := c.CacheFile + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, c.CacheFile)
		}
	}
	return &m, nil
}

// CacheFileIn is the default cache location next to the buffer directory.
func CacheFileIn(bufferDir string) string {
	return filepath.Join(filepath.Dir(filepath.Clean(bufferDir)), "podmap.json")
}

// IPMapPath serves the cluster-wide address map (ADR-101).
const IPMapPath = "/v1/ipmap"

// IPMap maps the cluster's addresses to what they belong to.
type IPMap struct {
	Pods     []IPPod     `json:"pods"`
	Services []IPService `json:"services"`
	Nodes    []IPNode    `json:"nodes"`
}

// IPPod is a pod IP and its workload.
type IPPod struct {
	IP           string `json:"ip"`
	Namespace    string `json:"namespace"`
	Pod          string `json:"pod"`
	WorkloadKind string `json:"workload_kind"`
	Workload     string `json:"workload"`
}

// IPService is a Service's cluster IPs (as clients see them, before DNAT) and the
// workloads behind its ready endpoints.
type IPService struct {
	IPs       []string   `json:"ips"`
	Namespace string     `json:"namespace"`
	Name      string     `json:"name"`
	Workloads []Workload `json:"workloads"`
}

// Workload names a pod owner.
type Workload struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// IPNode is a node address.
type IPNode struct {
	IP   string `json:"ip"`
	Name string `json:"name"`
}

// FetchIPMap asks the cluster-agent for the cluster-wide address map (ADR-101). On
// failure or 304 the previous map stays in use.
func (c *Client) FetchIPMap(ctx context.Context) (*IPMap, error) {
	c.mu.Lock()
	last, etag := c.ipLast, c.ipETag
	c.mu.Unlock()
	token, err := os.ReadFile(c.TokenFile) //nolint:gosec // path from configuration
	if err != nil {
		return last, fmt.Errorf("ip map token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+IPMapPath, nil)
	if err != nil {
		return last, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	if etag != "" && last != nil {
		req.Header.Set("If-None-Match", etag)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return last, err
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case http.StatusNotModified:
		return last, nil
	case http.StatusOK:
	default:
		b, _ := io.ReadAll(io.LimitReader(res.Body, 256))
		return last, fmt.Errorf("ip map: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var m IPMap
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&m); err != nil {
		return last, fmt.Errorf("ip map: %w", err)
	}
	c.mu.Lock()
	c.ipLast, c.ipETag = &m, res.Header.Get("ETag")
	c.mu.Unlock()
	return &m, nil
}
