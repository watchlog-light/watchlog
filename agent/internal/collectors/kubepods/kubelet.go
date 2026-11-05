// SPDX-License-Identifier: AGPL-3.0-only

package kubepods

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Kubelet TLS modes (ADR-051).
const (
	TLSAuto   = "auto"
	TLSVerify = "verify"
	TLSSkip   = "skip"
)

// FsStats is a filesystem usage entry of the summary.
type FsStats struct {
	UsedBytes     *uint64 `json:"usedBytes"`
	CapacityBytes *uint64 `json:"capacityBytes"`
}

// PodStats holds the fields WatchLog reads from one pod of /stats/summary
// (shape measured on kind and k3s: agent/internal/collectors/*/testdata).
type PodStats struct {
	PodRef struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		UID       string `json:"uid"`
	} `json:"podRef"`
	Containers []struct {
		Name   string   `json:"name"`
		Rootfs *FsStats `json:"rootfs"`
	} `json:"containers"`
	Network *struct {
		RxBytes *uint64 `json:"rxBytes"`
		TxBytes *uint64 `json:"txBytes"`
	} `json:"network"`
	Volume []struct {
		Name   string `json:"name"`
		PVCRef *struct {
			Name string `json:"name"`
		} `json:"pvcRef"`
		FsStats
	} `json:"volume"`
	EphemeralStorage *FsStats `json:"ephemeral-storage"`
}

// StatsSummary is the part of /stats/summary WatchLog reads.
type StatsSummary struct {
	Pods []PodStats `json:"pods"`
}

func (p PodStats) samples() []metrics.Sample {
	var out []metrics.Sample
	if n := p.Network; n != nil {
		if n.RxBytes != nil {
			out = append(out, metrics.New("watchlog_pod_network_bytes_total", float64(*n.RxBytes), "dir", "rx"))
		}
		if n.TxBytes != nil {
			out = append(out, metrics.New("watchlog_pod_network_bytes_total", float64(*n.TxBytes), "dir", "tx"))
		}
	}
	if e := p.EphemeralStorage; e != nil && e.UsedBytes != nil {
		out = append(out, metrics.New("watchlog_pod_ephemeral_storage_bytes", float64(*e.UsedBytes)))
	}
	for _, c := range p.Containers {
		if c.Rootfs != nil && c.Rootfs.UsedBytes != nil { // the writable layer, like Docker's SizeRw
			out = append(out, metrics.New("watchlog_container_fs_bytes", float64(*c.Rootfs.UsedBytes), "container", c.Name))
		}
	}
	// PVC usage: only volume plugins with metrics report it (measured: kind's and k3s's
	// local-path hostPath volumes are absent from the summary).
	for _, v := range p.Volume {
		if v.PVCRef == nil {
			continue
		}
		if v.UsedBytes != nil {
			out = append(out, metrics.New("watchlog_pod_volume_bytes", float64(*v.UsedBytes), "persistentvolumeclaim", v.PVCRef.Name, "state", "used"))
		}
		if v.CapacityBytes != nil {
			out = append(out, metrics.New("watchlog_pod_volume_bytes", float64(*v.CapacityBytes), "persistentvolumeclaim", v.PVCRef.Name, "state", "capacity"))
		}
	}
	return out
}

// Kubelet reads the node's own kubelet summary (ADR-051).
type Kubelet struct {
	URL       string // https://<status.hostIP>:10250/stats/summary
	TokenFile string
	Mode      string
	Log       *slog.Logger

	verified, insecure *http.Client
	mu                 sync.Mutex
	state              string // "", verified, unverified
}

// NewKubelet returns a client; caFile is the ServiceAccount CA bundle.
func NewKubelet(url, caFile, tokenFile, mode string, log *slog.Logger) (*Kubelet, error) {
	if mode != TLSAuto && mode != TLSVerify && mode != TLSSkip {
		return nil, fmt.Errorf("kubelet TLS mode %q: must be auto, verify or skip", mode)
	}
	k := &Kubelet{URL: url, TokenFile: tokenFile, Mode: mode, Log: log}
	if mode != TLSSkip {
		pem, err := os.ReadFile(caFile) //nolint:gosec // path from configuration
		if err != nil {
			return nil, fmt.Errorf("kubelet CA: %w", err)
		}
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pem)
		k.verified = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	}
	if mode != TLSVerify {
		k.insecure = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
			// Only ever used for the node's own kubelet, and reported (ADR-051).
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}}} //nolint:gosec // opt-in fallback, ADR-051
	}
	return k, nil
}

// TLS reports how the kubelet connection is secured: verified, unverified or "".
func (k *Kubelet) TLS() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.state
}

func isVerifyError(err error) bool {
	var v *tls.CertificateVerificationError
	var u x509.UnknownAuthorityError
	var h x509.HostnameError
	return errors.As(err, &v) || errors.As(err, &u) || errors.As(err, &h)
}

// Fetch reads /stats/summary. In auto mode a verification failure switches to an
// unverified connection for the rest of the process's life.
func (k *Kubelet) Fetch(ctx context.Context) (*StatsSummary, error) {
	k.mu.Lock()
	client, state := k.verified, TLSVerify
	if k.Mode == TLSSkip || k.state == "unverified" {
		client, state = k.insecure, "unverified"
	}
	k.mu.Unlock()
	s, err := k.get(ctx, client)
	if err != nil && state == TLSVerify && k.Mode == TLSAuto && isVerifyError(err) {
		k.Log.Warn("kubelet certificate not verifiable with the cluster CA; continuing without verification (kubelet.tls: auto)", "err", err)
		k.mu.Lock()
		k.state = "unverified"
		k.mu.Unlock()
		return k.get(ctx, k.insecure)
	}
	if err == nil {
		k.mu.Lock()
		if state == TLSVerify {
			k.state = "verified"
		} else {
			k.state = "unverified"
		}
		k.mu.Unlock()
	}
	return s, err
}

func (k *Kubelet) get(ctx context.Context, client *http.Client) (*StatsSummary, error) {
	token, err := os.ReadFile(k.TokenFile) //nolint:gosec // path from configuration
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 256))
		return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var s StatsSummary
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(&s); err != nil {
		return nil, err
	}
	return &s, nil
}
