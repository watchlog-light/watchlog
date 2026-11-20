// SPDX-License-Identifier: AGPL-3.0-only

package certs

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

// A test CA made here, in memory (ADR-222's rule: never a real CA, never a real certificate).
type ca struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

var serial int64

func mkCert(t *testing.T, tmpl *x509.Certificate, parent *ca) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial++
	tmpl.SerialNumber = big.NewInt(serial)
	signer, signKey := tmpl, key
	if parent != nil {
		signer, signKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, signer, &key.PublicKey, signKey)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return c, key
}

func newRoot(t *testing.T) *ca {
	c, k := mkCert(t, &x509.Certificate{Subject: pkix.Name{CommonName: "WatchLog Test Root"}, NotBefore: time.Now().Add(-2 * 365 * 24 * time.Hour),
		NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}, nil)
	return &ca{c, k}
}

func newInter(t *testing.T, root *ca) *ca {
	c, k := mkCert(t, &x509.Certificate{Subject: pkix.Name{CommonName: "WatchLog Test Intermediate"}, NotBefore: time.Now().Add(-365 * 24 * time.Hour),
		NotAfter: time.Now().Add(5 * 365 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}, root)
	return &ca{c, k}
}

func leaf(t *testing.T, issuer *ca, days int, aia bool, names ...string) tls.Certificate {
	tmpl := &x509.Certificate{Subject: pkix.Name{CommonName: names[0]}, DNSNames: names,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Duration(days) * 24 * time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if days < 0 { // an expired certificate: valid for 90 days until it ended
		tmpl.NotBefore = tmpl.NotAfter.Add(-90 * 24 * time.Hour)
	}
	if aia {
		tmpl.IssuingCertificateURL = []string{"https://ca.example.test/int.der"}
	}
	c, k := mkCert(t, tmpl, issuer)
	return tls.Certificate{Certificate: [][]byte{c.Raw}, PrivateKey: k, Leaf: c}
}

func withChain(c tls.Certificate, chain ...*x509.Certificate) tls.Certificate {
	for _, x := range chain {
		c.Certificate = append(c.Certificate, x.Raw)
	}
	return c
}

// serveTLS listens on 127.0.0.1 and answers each SNI name with its certificate.
func serveTLS(t *testing.T, def tls.Certificate, byName map[string]tls.Certificate) uint16 {
	t.Helper()
	cfg := &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if c, ok := byName[h.ServerName]; ok {
			return &c, nil
		}
		return &def, nil
	}}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _ = c.(*tls.Conn).Handshake(); _ = c.Close() }()
		}
	}()
	return uint16(ln.Addr().(*net.TCPAddr).Port)
}

func target(port uint16, workload string) Target {
	return Target{Kind: "Service", Workload: workload, Proto: "tcp", Port: port, Addrs: []string{"0.0.0.0"}}
}

func TestSNIVhostsChainsAndCoverage(t *testing.T) {
	root := newRoot(t)
	inter := newInter(t, root)
	roots := x509.NewCertPool()
	roots.AddCert(root.cert)
	a := withChain(leaf(t, inter, 80, true, "a.wl.test", "www.a.wl.test"), inter.cert)
	b := withChain(leaf(t, inter, 5, true, "b.wl.test"), inter.cert)
	c := leaf(t, inter, 200, true, "c.wl.test") // the leaf alone: the intermediate is missing
	port := serveTLS(t, a, map[string]tls.Certificate{"b.wl.test": b, "c.wl.test": c})
	col := &Collector{
		Targets:    func() []Target { return []Target{target(port, "nginx.service")} },
		StoreNames: func() []string { return []string{"a.wl.test", "b.wl.test", "c.wl.test", "gone.wl.test"} },
		Roots:      roots,
	}
	col.Round(context.Background())
	certs, cov := col.Certificates()
	if len(certs) != 3 {
		t.Fatalf("3 certificates expected, got %d: %+v", len(certs), certs)
	}
	// Soonest first: b (5 days), a (80), c (200).
	if certs[0].Names[0] != "b.wl.test" || certs[1].Names[0] != "a.wl.test" || certs[2].Names[0] != "c.wl.test" {
		t.Fatalf("order: %v %v %v", certs[0].Names, certs[1].Names, certs[2].Names)
	}
	if certs[1].Chain != ChainComplete || certs[2].Chain != ChainIncomplete {
		t.Fatalf("chains: a=%s c=%s", certs[1].Chain, certs[2].Chain)
	}
	if got := certs[1].Names; len(got) != 2 || got[1] != "www.a.wl.test" {
		t.Fatalf("a's names: %v", got)
	}
	if certs[0].Endpoints[0].SNI != "b.wl.test" || certs[0].Endpoints[0].Workload != "nginx.service" || certs[0].Endpoints[0].Proto != "tls" {
		t.Fatalf("b's endpoint: %+v", certs[0].Endpoints)
	}
	if cov.TLSPorts != 1 || cov.Ports != 1 || len(cov.Unserved) != 1 || cov.Unserved[0] != "gone.wl.test" {
		t.Fatalf("coverage: %+v", cov)
	}
	// The series: one expiry per certificate, and c's chain problem.
	samples, _ := col.Collect()
	var exp, problems int
	for _, s := range samples {
		switch s.Name {
		case "watchlog_cert_expires_at_seconds":
			exp++
		case "watchlog_cert_problem":
			problems++
			if s.Labels[0].Value != "c.wl.test" || s.Labels[2].Value != "chain" {
				t.Fatalf("problem: %+v", s)
			}
		}
	}
	if exp != 3 || problems != 1 {
		t.Fatalf("series: %d expiries, %d problems", exp, problems)
	}
}

func TestPrivateAndSelfSignedAreNotIncomplete(t *testing.T) {
	root := newRoot(t)
	inter := newInter(t, root)
	empty := x509.NewCertPool()
	now := time.Now()
	priv := leaf(t, inter, 300, false, "db.internal")
	// An internal CA (no AIA), the intermediate sent: not trusted here, not incomplete.
	if got := chainState([]*x509.Certificate{priv.Leaf, inter.cert}, empty, now); got != ChainPrivate {
		t.Fatalf("private: %s", got)
	}
	if got := chainState([]*x509.Certificate{priv.Leaf}, empty, now); got != ChainPrivate {
		t.Fatalf("private leaf alone: %s", got)
	}
	self, _ := mkCert(t, &x509.Certificate{Subject: pkix.Name{CommonName: "self.test"}, DNSNames: []string{"self.test"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageCertSign}, nil)
	if got := chainState([]*x509.Certificate{self}, empty, now); got != ChainSelfSigned {
		t.Fatalf("self-signed: %s", got)
	}
	// An expired certificate's chain is still judged (expiry is its own alert).
	roots := x509.NewCertPool()
	roots.AddCert(root.cert)
	old := withChain(leaf(t, inter, -2, true, "old.wl.test"), inter.cert)
	if got := chainState([]*x509.Certificate{old.Leaf, inter.cert}, roots, now); got != ChainComplete {
		t.Fatalf("an expired leaf with its chain: %s", got)
	}
}

func TestOneCertificateOnTwoPortsIsOneRow(t *testing.T) {
	root := newRoot(t)
	inter := newInter(t, root)
	mail := withChain(leaf(t, inter, 365, true, "mail.wl.test"), inter.cert)
	p1 := serveTLS(t, mail, nil)
	p2 := serveTLS(t, mail, nil)
	col := &Collector{Targets: func() []Target {
		return []Target{target(p1, "postfix.service"), target(p2, "dovecot.service")}
	}}
	col.Round(context.Background())
	certs, _ := col.Certificates()
	if len(certs) != 1 || len(certs[0].Endpoints) != 2 {
		t.Fatalf("one certificate on two ports: %+v", certs)
	}
	if certs[0].Endpoints[0].Workload == certs[0].Endpoints[1].Workload {
		t.Fatalf("both workloads kept: %+v", certs[0].Endpoints)
	}
}

func TestAPortThatIsNotTLSIsLeftAloneForAnHour(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	var conns atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			conns.Add(1)
			_, _ = io.WriteString(c, "SSH-2.0-OpenSSH_9.6\r\n")
			_ = c.Close()
		}
	}()
	port := uint16(ln.Addr().(*net.TCPAddr).Port)
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	col := &Collector{Targets: func() []Target { return []Target{target(port, "ssh.service")} }, Now: func() time.Time { return now }}
	col.Round(context.Background())
	col.Round(context.Background())
	if conns.Load() != 1 {
		t.Fatalf("the second round within the hour should skip it: %d connections", conns.Load())
	}
	now = now.Add(61 * time.Minute)
	col.Round(context.Background())
	if conns.Load() != 2 {
		t.Fatalf("an hour later it is asked again: %d", conns.Load())
	}
	if certs, cov := col.Certificates(); len(certs) != 0 || cov.TLSPorts != 0 {
		t.Fatalf("no certificate: %+v %+v", certs, cov)
	}
}

// serveSTARTTLS runs a plain server that does `pre` and then a TLS handshake.
func serveSTARTTLS(t *testing.T, cert tls.Certificate, pre func(c net.Conn, r *bufio.Reader) bool) uint16 {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				r := bufio.NewReader(c)
				if !pre(c, r) {
					return
				}
				// The client may send its hello right after the upgrade request (MySQL doesn't
				// wait for an answer): bytes already buffered are the TLS server's.
				_ = tls.Server(bufConn{c, r}, &tls.Config{Certificates: []tls.Certificate{cert}}).Handshake()
			}()
		}
	}()
	return uint16(ln.Addr().(*net.TCPAddr).Port)
}

type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

func TestSTARTTLS(t *testing.T) {
	root := newRoot(t)
	inter := newInter(t, root)
	cert := withChain(leaf(t, inter, 365, true, "mail.wl.test"), inter.cert)
	smtp := serveSTARTTLS(t, cert, func(c net.Conn, r *bufio.Reader) bool {
		_, _ = io.WriteString(c, "220 mail.wl.test ESMTP\r\n")
		if l, _ := r.ReadString('\n'); !strings.HasPrefix(l, "EHLO") {
			return false
		}
		_, _ = io.WriteString(c, "250-mail.wl.test\r\n250-STARTTLS\r\n250 SMTPUTF8\r\n")
		if l, _ := r.ReadString('\n'); l != "STARTTLS\r\n" {
			return false
		}
		_, _ = io.WriteString(c, "220 2.0.0 Ready to start TLS\r\n")
		return true
	})
	imap := serveSTARTTLS(t, cert, func(c net.Conn, r *bufio.Reader) bool {
		_, _ = io.WriteString(c, "* OK [CAPABILITY IMAP4rev1 STARTTLS] Dovecot ready.\r\n")
		if l, _ := r.ReadString('\n'); l != "w1 STARTTLS\r\n" {
			return false
		}
		_, _ = io.WriteString(c, "w1 OK Begin TLS negotiation now.\r\n")
		return true
	})
	pg := serveSTARTTLS(t, cert, func(c net.Conn, r *bufio.Reader) bool {
		b := make([]byte, 8)
		if _, err := io.ReadFull(r, b); err != nil || binary.BigEndian.Uint32(b[4:]) != 80877103 {
			return false
		}
		_, _ = c.Write([]byte{'S'})
		return true
	})
	mysql := serveSTARTTLS(t, cert, func(c net.Conn, r *bufio.Reader) bool {
		// A protocol-10 handshake offering SSL (capability 0x0800).
		body := []byte{10}
		body = append(body, []byte("8.0.40\x00")...)
		body = append(body, 1, 0, 0, 0)            // thread id
		body = append(body, []byte("abcdefgh")...) // auth part 1
		body = append(body, 0)                     // filler
		body = append(body, 0xff, 0xff)            // capabilities, low: SSL among them
		body = append(body, make([]byte, 30)...)
		head := []byte{byte(len(body)), byte(len(body) >> 8), 0, 0}
		_, _ = c.Write(append(head, body...))
		req := make([]byte, 36)
		if _, err := io.ReadFull(r, req); err != nil || binary.LittleEndian.Uint32(req[4:])&0x0800 == 0 {
			return false
		}
		return true
	})
	steps := map[uint16]string{smtp: "smtp", imap: "imap", pg: "postgresql", mysql: "mysql"}
	col := &Collector{
		Targets: func() []Target {
			return []Target{target(smtp, "postfix.service"), target(imap, "dovecot.service"), target(pg, "postgresql.service"), target(mysql, "mysql.service")}
		},
		Probe: Probe{Steps: func(p uint16) string { return steps[p] }},
	}
	col.Round(context.Background())
	certs, cov := col.Certificates()
	if len(certs) != 1 || len(certs[0].Endpoints) != 4 || cov.TLSPorts != 4 {
		t.Fatalf("one certificate on four STARTTLS ports: %+v %+v", certs, cov)
	}
	got := map[string]bool{}
	for _, e := range certs[0].Endpoints {
		got[e.Proto] = true
	}
	for _, p := range []string{"smtp", "imap", "postgresql", "mysql"} {
		if !got[p] {
			t.Fatalf("%s missing: %+v", p, certs[0].Endpoints)
		}
	}
}

func TestANameAnsweredWithTheWrongCertificate(t *testing.T) {
	root := newRoot(t)
	inter := newInter(t, root)
	def := withChain(leaf(t, inter, 90, true, "a.wl.test"), inter.cert)
	wrong := withChain(leaf(t, inter, 90, true, "x.wl.test"), inter.cert)
	port := serveTLS(t, def, map[string]tls.Certificate{"b.wl.test": wrong})
	col := &Collector{Targets: func() []Target { return []Target{target(port, "nginx.service")} },
		StoreNames: func() []string { return []string{"b.wl.test"} }}
	col.Round(context.Background())
	certs, cov := col.Certificates()
	var x *Cert
	for i := range certs {
		if certs[i].Names[0] == "x.wl.test" {
			x = &certs[i]
		}
	}
	if x == nil || len(x.NameMismatch) != 1 || x.NameMismatch[0] != "b.wl.test" {
		t.Fatalf("b.wl.test answered with x's certificate: %+v", certs)
	}
	if len(cov.Unserved) != 1 {
		t.Fatalf("b.wl.test is in a store and no port serves it: %+v", cov)
	}
}

func TestStoreNamesAreDirectoryNamesOnly(t *testing.T) {
	root := fstest.MapFS{
		"etc/letsencrypt/live/a.example.com/privkey.pem":                                 {Data: []byte("never read")},
		"etc/letsencrypt/live/a.example.com/fullchain.pem":                               {Data: []byte("never read")},
		"etc/letsencrypt/live/README":                                                    {Data: []byte("a file, not a name")},
		"root/.acme.sh/b.example.com_ecc/b.example.com.key":                              {Data: []byte("x")},
		"root/.acme.sh/ca/x":                                                             {Data: []byte("x")},
		"home/deploy/.acme.sh/c.example.com/c.example.com.cer":                           {Data: []byte("x")},
		"var/lib/caddy/.local/share/caddy/certificates/acme-v02/wildcard_.example.org/x": {Data: []byte("x")},
	}
	got := StoreNames(root)
	want := []string{"a.example.com", "b.example.com", "c.example.com", "watchlog-check.example.org"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("store names: %v", got)
	}
}

func TestWhereAPortIsRead(t *testing.T) {
	c := &Collector{}
	if a, ok := c.dialAddr(Target{Port: 443, Addrs: []string{"0.0.0.0"}}); !ok || a != "127.0.0.1:443" {
		t.Fatal(a)
	}
	if a, ok := c.dialAddr(Target{Port: 8443, Addrs: []string{"10.0.0.5"}}); !ok || a != "10.0.0.5:8443" {
		t.Fatal(a)
	}
	if a, ok := c.dialAddr(Target{Port: 993, Addrs: []string{"::1"}}); !ok || a != "[::1]:993" {
		t.Fatal(a)
	}
	// From a docker run install: the host through its gateway; its loopback can't be reached.
	d := &Collector{HostAddr: "172.17.0.1"}
	if a, ok := d.dialAddr(Target{Port: 443, Addrs: []string{"::"}}); !ok || a != "172.17.0.1:443" {
		t.Fatal(a)
	}
	if _, ok := d.dialAddr(Target{Port: 5432, Addrs: []string{"127.0.0.1"}}); ok {
		t.Fatal("loopback-only is unreachable from another namespace")
	}
	dir := t.TempDir()
	route := filepath.Join(dir, "route")
	_ = os.WriteFile(route, []byte("Iface\tDestination\tGateway\tFlags\nlo\t0000007F\t00000000\t0001\neth0\t00000000\t010011AC\t0003\n"), 0o644)
	if g := HostRoute(route); g != "172.17.0.1" {
		t.Fatalf("gateway %q", g)
	}
}

func TestCaps(t *testing.T) {
	var targets []Target
	for p := 1; p <= MaxPorts+7; p++ {
		targets = append(targets, Target{Kind: "Service", Workload: "x", Port: uint16(p), Addrs: []string{"192.0.2.1"}})
	}
	col := &Collector{Targets: func() []Target { return targets },
		Probe: Probe{Dial: func(ctx context.Context, n, a string) (net.Conn, error) {
			return nil, &net.OpError{Op: "dial", Err: os.ErrDeadlineExceeded}
		}}}
	col.Round(context.Background())
	_, cov := col.Certificates()
	if cov.Ports != MaxPorts || cov.OverCap != 7 {
		t.Fatalf("caps: %+v", cov)
	}
}

// A cluster's targets: a Service read at its address, and an Ingress's declared hosts asked
// for by name on the same address, where the controller's default certificate answering a
// host is a name mismatch (its TLS Secret is missing or wrong).
func TestDeclaredNamesOnAnAddress(t *testing.T) {
	root := newRoot(t)
	inter := newInter(t, root)
	def := withChain(leaf(t, inter, 90, true, "ingress.default.wl.test"), inter.cert)
	shop := withChain(leaf(t, inter, 60, true, "shop.wl.test"), inter.cert)
	port := serveTLS(t, def, map[string]tls.Certificate{"shop.wl.test": shop})
	col := &Collector{Targets: func() []Target {
		return []Target{
			{Kind: "Service", Workload: "ingress-nginx/controller", Proto: "tcp", Port: port, Addr: "127.0.0.1"},
			{Kind: "Ingress", Workload: "shop/web", Proto: "tcp", Port: port, Addr: "127.0.0.1",
				Names: []string{"api.wl.test", "shop.wl.test"}, SNIOnly: true},
		}
	}}
	col.Round(context.Background())
	certs, cov := col.Certificates()
	byName := map[string]Cert{}
	for _, c := range certs {
		byName[c.Names[0]] = c
	}
	s, ok := byName["shop.wl.test"]
	if !ok || len(s.Endpoints) != 1 || s.Endpoints[0].Kind != "Ingress" || s.Endpoints[0].SNI != "shop.wl.test" || len(s.NameMismatch) != 0 {
		t.Fatalf("shop's certificate on the Ingress: %+v", certs)
	}
	d := byName["ingress.default.wl.test"]
	if len(d.NameMismatch) != 1 || d.NameMismatch[0] != "api.wl.test" || len(d.Endpoints) != 2 {
		t.Fatalf("api.wl.test answered with the default certificate: %+v", d)
	}
	if cov.Ports != 2 || cov.TLSPorts != 2 || len(cov.Unserved) != 1 || cov.Unserved[0] != "api.wl.test" {
		t.Fatalf("coverage: %+v", cov)
	}
}
