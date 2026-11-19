// SPDX-License-Identifier: AGPL-3.0-only

// Package certs finds the TLS certificates a server presents (ADR-222): every 10 minutes it
// opens a handshake to each TCP port its workloads listen on (after STARTTLS where the port
// needs one), and asks again with each name a certificate store lists (directory names only),
// so several certificates behind one port are found. It reads what the port presents: no
// private key and no file of a store is ever opened, and nothing is decrypted. A certificate
// is identified on the server by its names, so one certificate on five ports is one row and
// a renewed one keeps its row.
package certs

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io/fs"
	"net"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// Caps (ADR-222).
const (
	MaxPorts      = 50
	MaxCerts      = 100
	MaxStoreNames = 50
	Concurrency   = 4
	// Every is how often a round runs.
	Every = 10 * time.Minute
	// NotTLSFor is how long a port that isn't TLS is left alone.
	NotTLSFor = time.Hour
)

// Target is one listening TCP port of a workload.
type Target struct {
	Kind     string // Service or ProcessGroup
	Workload string
	Proto    string // tcp or tcp6
	Port     uint16
	Addrs    []string // the addresses it is bound to
}

// Endpoint is where a certificate was seen.
type Endpoint struct {
	Kind        string `json:"kind"`
	Workload    string `json:"workload"`
	Port        uint16 `json:"port"`
	Proto       string `json:"proto"`
	SNI         string `json:"sni,omitempty"`
	Fingerprint string `json:"fingerprint"`
	NotAfter    int64  `json:"notAfter"`
}

// Cert is one certificate (by its names) on this server.
type Cert struct {
	ID           string     `json:"id"`
	Names        []string   `json:"names"`
	Subject      string     `json:"subject"`
	Issuer       string     `json:"issuer"`
	IssuerOrg    string     `json:"issuerOrg,omitempty"`
	Serial       string     `json:"serial"`
	NotBefore    int64      `json:"notBefore"`
	NotAfter     int64      `json:"notAfter"`
	Fingerprint  string     `json:"fingerprint"`
	KeyType      string     `json:"keyType"`
	KeyBits      int        `json:"keyBits"`
	Chain        string     `json:"chain"`
	NameMismatch []string   `json:"nameMismatch,omitempty"`
	Endpoints    []Endpoint `json:"endpoints"`
}

// Coverage is what a round could and couldn't read, for the page's "not covered".
type Coverage struct {
	Ports        int      `json:"ports"`
	TLSPorts     int      `json:"tlsPorts"`
	OverCap      int      `json:"overCap"`
	Unreachable  int      `json:"unreachable"`
	StoreNames   int      `json:"storeNames"`
	Unserved     []string `json:"unserved,omitempty"`
	CertsOverCap int      `json:"certsOverCap"`
	At           int64    `json:"at"`
}

// Collector runs the rounds and keeps the last one's result.
type Collector struct {
	Targets    func() []Target
	StoreNames func() []string
	Probe      Probe
	// Roots is the server's trust store (nil: the system's).
	Roots *x509.CertPool
	// HostAddr, when set, is the address the host is reached on from the agent's network
	// namespace (a docker run install): ports bound to every address are read there, and
	// ports bound to loopback only can't be.
	HostAddr string
	Now      func() time.Time

	mu       sync.Mutex
	certs    []Cert
	coverage Coverage
	notTLS   map[string]time.Time
}

func (c *Collector) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Run rounds every Every until ctx ends.
func (c *Collector) Run(ctx context.Context) {
	for {
		c.Round(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(Every):
		}
	}
}

type seen struct {
	t    Target
	sni  string
	pres Presented
}

// Round probes every port once (and each store name on each TLS port) and replaces the result.
func (c *Collector) Round(ctx context.Context) {
	now := c.now()
	targets := c.Targets()
	sort.Slice(targets, func(i, j int) bool {
		if targets[i].Port != targets[j].Port {
			return targets[i].Port < targets[j].Port
		}
		return targets[i].Workload < targets[j].Workload
	})
	cov := Coverage{At: now.Unix()}
	// One port bound for both IPv4 and IPv6 is one port.
	byPort := map[uint16]Target{}
	var order []uint16
	for _, t := range targets {
		if prev, ok := byPort[t.Port]; ok {
			prev.Addrs = append(prev.Addrs, t.Addrs...)
			byPort[t.Port] = prev
			continue
		}
		byPort[t.Port] = t
		order = append(order, t.Port)
	}
	if len(order) > MaxPorts {
		cov.OverCap = len(order) - MaxPorts
		order = order[:MaxPorts]
	}
	cov.Ports = len(order)
	var names []string
	if c.StoreNames != nil {
		names = c.StoreNames()
	}
	cov.StoreNames = len(names)

	c.mu.Lock()
	if c.notTLS == nil {
		c.notTLS = map[string]time.Time{}
	}
	c.mu.Unlock()

	var (
		mu    sync.Mutex
		found []seen
		wg    sync.WaitGroup
		slots = make(chan struct{}, Concurrency)
	)
	for _, port := range order {
		t := byPort[port]
		addr, ok := c.dialAddr(t)
		if !ok {
			mu.Lock()
			cov.Unreachable++
			mu.Unlock()
			continue
		}
		c.mu.Lock()
		until, skip := c.notTLS[addr]
		c.mu.Unlock()
		if skip && now.Before(until) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			first, err := c.Probe.Handshake(ctx, addr, t.Port, "")
			if err != nil {
				var nerr net.Error
				if errors.Is(err, ErrNotTLS) || (errors.As(err, &nerr) && nerr.Timeout()) || errors.Is(err, context.DeadlineExceeded) {
					c.mu.Lock()
					c.notTLS[addr] = now.Add(NotTLSFor)
					c.mu.Unlock()
				}
				return
			}
			local := []seen{{t: t, pres: first}}
			if first.Proto == "tls" {
				def := first.Chain[0]
				for _, n := range names {
					p, err := c.Probe.Handshake(ctx, addr, t.Port, n)
					if err != nil || len(p.Chain) == 0 {
						continue
					}
					// A port that answers every name with its default certificate doesn't serve
					// that name; a different certificate means a vhost for it.
					if fingerprint(p.Chain[0]) == fingerprint(def) && !covers(def, n) {
						continue
					}
					local = append(local, seen{t: t, sni: n, pres: p})
				}
			}
			mu.Lock()
			found = append(found, local...)
			cov.TLSPorts++
			mu.Unlock()
		}()
	}
	wg.Wait()

	certs, served := c.assemble(found, now)
	for _, n := range names {
		if !served[n] {
			cov.Unserved = append(cov.Unserved, strings.Replace(n, wildcardProbe, "*", 1))
		}
	}
	sort.Strings(cov.Unserved)
	if len(certs) > MaxCerts {
		cov.CertsOverCap = len(certs) - MaxCerts
		certs = certs[:MaxCerts]
	}
	c.mu.Lock()
	c.certs, c.coverage = certs, cov
	c.mu.Unlock()
}

// dialAddr is where a target is read: its bound address, loopback for every address, or the
// host's address from another network namespace. False when it can't be reached from here.
func (c *Collector) dialAddr(t Target) (string, bool) {
	port := strconv.Itoa(int(t.Port))
	addrs := t.Addrs
	if len(addrs) == 0 {
		addrs = []string{""}
	}
	for _, a := range addrs {
		ip := net.ParseIP(a)
		wildcard := a == "" || (ip != nil && ip.IsUnspecified())
		switch {
		case wildcard && c.HostAddr != "":
			return net.JoinHostPort(c.HostAddr, port), true
		case wildcard:
			return net.JoinHostPort("127.0.0.1", port), true
		case ip != nil && ip.IsLoopback() && c.HostAddr != "":
			continue // the host's loopback isn't ours in another namespace
		case ip != nil:
			return net.JoinHostPort(a, port), true
		}
	}
	return "", false
}

// assemble groups what was seen by certificate names; a name is "served" when some port
// presented a certificate that covers it.
func (c *Collector) assemble(found []seen, now time.Time) ([]Cert, map[string]bool) {
	roots := c.Roots
	if roots == nil {
		if sys, err := x509.SystemCertPool(); err == nil {
			roots = sys
		} else {
			roots = x509.NewCertPool()
		}
	}
	byID := map[string]*Cert{}
	served := map[string]bool{}
	for _, s := range found {
		leaf := s.pres.Chain[0]
		names := namesOf(leaf)
		id := identity(names)
		cert := byID[id]
		state := chainState(s.pres.Chain, roots, now)
		if cert == nil || leaf.NotAfter.Unix() < cert.NotAfter {
			keyType, bits := keyOf(leaf)
			fresh := Cert{
				ID: id, Names: names, Subject: leaf.Subject.CommonName, Issuer: leaf.Issuer.CommonName,
				Serial: leaf.SerialNumber.Text(16), NotBefore: leaf.NotBefore.Unix(), NotAfter: leaf.NotAfter.Unix(),
				Fingerprint: fingerprint(leaf), KeyType: keyType, KeyBits: bits, Chain: state,
			}
			if len(leaf.Issuer.Organization) > 0 {
				fresh.IssuerOrg = leaf.Issuer.Organization[0]
			}
			if cert != nil {
				fresh.Endpoints, fresh.NameMismatch = cert.Endpoints, cert.NameMismatch
				if cert.Chain == ChainIncomplete {
					fresh.Chain = ChainIncomplete
				}
			}
			cert = &fresh
			byID[id] = cert
		} else if state == ChainIncomplete {
			cert.Chain = ChainIncomplete
		}
		if s.sni != "" {
			if covers(leaf, s.sni) {
				served[s.sni] = true
			} else if !contains(cert.NameMismatch, s.sni) {
				cert.NameMismatch = append(cert.NameMismatch, s.sni)
			}
		} else {
			for _, n := range names {
				served[n] = true
			}
		}
		ep := Endpoint{Kind: s.t.Kind, Workload: s.t.Workload, Port: s.t.Port, Proto: s.pres.Proto, SNI: s.sni,
			Fingerprint: fingerprint(leaf), NotAfter: leaf.NotAfter.Unix()}
		dup := false
		for _, e := range cert.Endpoints {
			if e.Port == ep.Port && e.Fingerprint == ep.Fingerprint {
				dup = true
				break
			}
		}
		if !dup {
			cert.Endpoints = append(cert.Endpoints, ep)
		}
	}
	out := make([]Cert, 0, len(byID))
	for _, c := range byID {
		sort.Slice(c.Endpoints, func(i, j int) bool { return c.Endpoints[i].Port < c.Endpoints[j].Port })
		sort.Strings(c.NameMismatch)
		out = append(out, *c)
	}
	// Soonest to expire first: what the caps keep.
	sort.Slice(out, func(i, j int) bool {
		if out[i].NotAfter != out[j].NotAfter {
			return out[i].NotAfter < out[j].NotAfter
		}
		return out[i].ID < out[j].ID
	})
	return out, served
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// Certificates is the last round's result.
func (c *Collector) Certificates() ([]Cert, Coverage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Cert(nil), c.certs...), c.coverage
}

// Collect sends the series the rules read (ADR-224): when each certificate expires, and its
// problems while it has them.
func (c *Collector) Collect() ([]metrics.Sample, error) {
	certs, _ := c.Certificates()
	var out []metrics.Sample
	for _, ct := range certs {
		name := ct.Names[0]
		out = append(out, metrics.New("watchlog_cert_expires_at_seconds", float64(ct.NotAfter), "cert", name, "cert_id", ct.ID))
		if ct.Chain == ChainIncomplete {
			out = append(out, metrics.New("watchlog_cert_problem", 1, "cert", name, "cert_id", ct.ID, "problem", "chain"))
		}
		if len(ct.NameMismatch) > 0 {
			out = append(out, metrics.New("watchlog_cert_problem", 1, "cert", name, "cert_id", ct.ID, "problem", "name"))
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------- certificate stores

// storeGlobs are the well-known certificate stores whose directory names are the names they
// hold certificates for: Let's Encrypt (certbot), acme.sh and Caddy. Only directories are
// listed; no file inside one is opened.
var storeGlobs = []string{
	"etc/letsencrypt/live/*",
	"root/.acme.sh/*",
	"home/*/.acme.sh/*",
	"var/lib/caddy/.local/share/caddy/certificates/*/*",
	"root/.local/share/caddy/certificates/*/*",
	"home/*/.local/share/caddy/certificates/*/*",
}

// wildcardProbe is the label a wildcard store name is asked for under.
const wildcardProbe = "watchlog-check"

var dnsName = regexp.MustCompile(`^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// StoreNames lists the names in the server's certificate stores, read under root (the host's
// filesystem as an fs.FS).
func StoreNames(root fs.FS) []string {
	seen := map[string]bool{}
	var out []string
	for _, g := range storeGlobs {
		dirs, _ := fs.Glob(root, g)
		for _, d := range dirs {
			st, err := fs.Stat(root, d)
			if err != nil || !st.IsDir() {
				continue
			}
			n := strings.ToLower(path.Base(d))
			n = strings.TrimSuffix(n, "_ecc") // acme.sh's ECC directories
			if strings.HasPrefix(n, "wildcard_.") {
				n = "*." + strings.TrimPrefix(n, "wildcard_.") // Caddy's wildcard names
			}
			if !dnsName.MatchString(n) || seen[n] {
				continue
			}
			seen[n] = true
			// A wildcard can't be asked for as SNI; a name under it can.
			if strings.HasPrefix(n, "*.") {
				n = wildcardProbe + n[1:]
			}
			out = append(out, n)
		}
	}
	sort.Strings(out)
	if len(out) > MaxStoreNames {
		out = out[:MaxStoreNames]
	}
	return out
}

// HostRoute is the default gateway of the agent's own network namespace, from
// /proc/self/net/route ("" when there is none): the host, seen from a container.
func HostRoute(procRoute string) string {
	b, err := os.ReadFile(procRoute) //nolint:gosec // the agent's own /proc/self/net/route
	if err != nil {
		return ""
	}
	for i, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 3 || f[1] != "00000000" {
			continue
		}
		gw, err := hex.DecodeString(f[2]) // little-endian: 010011AC is 172.17.0.1
		if err != nil || len(gw) != 4 || (gw[0]|gw[1]|gw[2]|gw[3]) == 0 {
			continue
		}
		return net.IPv4(gw[3], gw[2], gw[1], gw[0]).String()
	}
	return ""
}
