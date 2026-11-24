// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// RouterOS is a fake MikroTik router: the REST API over HTTPS, the API over TLS (API-SSL)
// and the plain API, answering the menus WatchLog prints from a model. It refuses anything
// that would change the router, and counts the attempts.
type RouterOS struct {
	User, Password string
	Clock          func() time.Time
	Start          time.Time

	mu      sync.Mutex
	menus   map[string][]map[string]string
	ifaces  []rosIface
	cert    tls.Certificate
	Writes  atomic.Int64 // requests that weren't reads
	Version string
	caps    *capsman
}

type rosIface struct {
	row          map[string]string
	inRate, outR float64
	base         float64
	monitor      map[string]string
}

// Edge is the office's router, edge-1: a CCR2004-16G-2S+ with its SFP+ uplinks to the core
// and the ISP.
func Edge(start time.Time) *RouterOS {
	r := &RouterOS{User: "watchlog", Password: "read-only-sample", Start: start, Version: "7.16.2 (stable)", menus: map[string][]map[string]string{}}
	r.menus["system/identity"] = []map[string]string{{"name": "edge-1"}}
	r.menus["system/routerboard"] = []map[string]string{{"routerboard": "true", "model": "CCR2004-16G-2S+", "serial-number": "HE10ABC0001", "current-firmware": "7.16.2", "upgrade-firmware": "7.16.2"}}
	r.menus["system/health"] = []map[string]string{
		{".id": "*1", "name": "cpu-temperature", "value": "51", "type": "C"},
		{".id": "*2", "name": "board-temperature1", "value": "39", "type": "C"},
		{".id": "*3", "name": "fan1-speed", "value": "4380", "type": "RPM"},
		{".id": "*4", "name": "fan2-speed", "value": "4410", "type": "RPM"},
		{".id": "*5", "name": "psu1-state", "value": "ok", "type": ""},
		{".id": "*6", "name": "psu2-state", "value": "ok", "type": ""},
	}
	r.menus["system/package/update"] = []map[string]string{{"channel": "stable", "installed-version": "7.16.2", "latest-version": "7.16.2", "status": "System is already up to date"}}
	r.menus["ip/neighbor"] = []map[string]string{
		{".id": "*1", "interface": "sfp-sfpplus1", "address": "10.0.0.2", "mac-address": MACString("core-1", 1), "identity": "core-1", "platform": "Cisco", "board": "N3K-C3064PQ-10GX", "interface-name": "Ethernet1/1", "discovered-by": "cdp,lldp"},
	}
	r.menus["ip/arp"] = []map[string]string{
		{".id": "*1", "address": "10.0.0.2", "mac-address": MACString("core-1", 1), "interface": "sfp-sfpplus1"},
		{".id": "*2", "address": "203.0.113.1", "mac-address": "02:00:5e:10:00:01", "interface": "sfp-sfpplus2"},
	}
	r.menus["interface/bridge/host"] = []map[string]string{
		{".id": "*1", "mac-address": "02:00:5e:10:00:21", "on-interface": "ether2", "vid": "1", "local": "false", "bridge": "bridge1"},
		{".id": "*2", "mac-address": "48:a9:8a:00:00:01", "on-interface": "bridge1", "vid": "1", "local": "true", "bridge": "bridge1"},
	}
	routes := []map[string]string{{".id": "*1", "dst-address": "0.0.0.0/0", "gateway": "203.0.113.1", "active": "true"}}
	for i := 0; i < 24; i++ {
		routes = append(routes, map[string]string{".id": "*" + strconv.Itoa(i+2), "dst-address": fmt.Sprintf("10.%d.0.0/16", i), "gateway": "10.0.0.2", "active": "true"})
	}
	r.menus["ip/route"] = routes
	add := func(name, typ, comment string, up bool, speed string, in, out float64, sfp bool) {
		row := map[string]string{
			".id": "*" + strconv.Itoa(len(r.ifaces)+1), "name": name, "type": typ, "mac-address": strings.ToUpper(MACString("edge-1", len(r.ifaces)+1)),
			"running": strconv.FormatBool(up), "disabled": "false", "comment": comment, "rx-error": "0", "tx-error": "0", "rx-drop": "0", "tx-drop": "0",
		}
		if comment == "" {
			delete(row, "comment")
		}
		mon := map[string]string{"name": name, "status": "link-ok", "rate": speed}
		if !up {
			mon = map[string]string{"name": name, "status": "no-link"}
		}
		if sfp && up {
			mon["sfp-rx-power"], mon["sfp-tx-power"], mon["sfp-temperature"] = "-3.112", "-2.474", "41"
		}
		r.ifaces = append(r.ifaces, rosIface{row: row, inRate: in, outR: out, base: float64(len(r.ifaces)) * 1e9, monitor: mon})
	}
	add("ether1", "ether", "management", true, "1Gbps", 2_000, 1_500, false)
	for i := 2; i <= 16; i++ {
		add(fmt.Sprintf("ether%d", i), "ether", "", i <= 3, "1Gbps", 30_000, 20_000, false)
	}
	add("sfp-sfpplus1", "ether", "to core-1", true, "10Gbps", 40_000_000, 25_000_000, true)
	add("sfp-sfpplus2", "ether", "ISP", true, "10Gbps", 25_000_000, 6_000_000, true)
	add("bridge1", "bridge", "", true, "", 0, 0, false)
	add("vlan150", "vlan", "Wi-Fi", true, "", 0, 0, false)
	// The APs, managed by this router's CAPsMAN (0.17).
	r.caps = &capsman{down: map[string]bool{}}
	return r
}

func (r *RouterOS) now() time.Time {
	if r.Clock != nil {
		return r.Clock()
	}
	return time.Now()
}

// SetRunning sets a port's link (a flap in the demo).
func (r *RouterOS) SetRunning(name string, up bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.ifaces {
		if r.ifaces[i].row["name"] == name {
			r.ifaces[i].row["running"] = strconv.FormatBool(up)
		}
	}
}

func (r *RouterOS) menu(path string) ([]map[string]string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	secs := r.now().Sub(r.Start).Seconds()
	switch path {
	case "system/resource":
		return []map[string]string{{
			"uptime": fmtUptime(r.now().Sub(r.Start)), "version": r.Version, "cpu-load": "4", "free-memory": "3221225472",
			"total-memory": "4294967296", "board-name": "CCR2004-16G-2S+", "architecture-name": "arm64", "cpu-count": "4",
		}}, true
	case "interface":
		out := make([]map[string]string, len(r.ifaces))
		for i, f := range r.ifaces {
			row := map[string]string{}
			for k, v := range f.row {
				row[k] = v
			}
			row["rx-byte"] = strconv.FormatUint(uint64(f.base+f.inRate*secs), 10)
			row["tx-byte"] = strconv.FormatUint(uint64(f.base/2+f.outR*secs), 10)
			out[i] = row
		}
		return out, true
	case "interface/ethernet":
		var out []map[string]string
		for _, f := range r.ifaces {
			if f.row["type"] == "ether" {
				out = append(out, map[string]string{".id": f.row[".id"], "name": f.row["name"]})
			}
		}
		return out, true
	}
	if rows, ok := r.wifiMenu(path, r.now()); ok {
		return rows, true
	}
	rows, ok := r.menus[path]
	return rows, ok
}

func (r *RouterOS) monitor(ids []string) []map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	var out []map[string]string
	for _, f := range r.ifaces {
		if want[f.row[".id"]] || want[f.row["name"]] {
			m := map[string]string{}
			for k, v := range f.monitor {
				m[k] = v
			}
			if f.row["running"] != "true" {
				m = map[string]string{"name": f.row["name"], "status": "no-link"}
			}
			out = append(out, m)
		}
	}
	return out
}

func fmtUptime(d time.Duration) string {
	w := int(d / (7 * 24 * time.Hour))
	d -= time.Duration(w) * 7 * 24 * time.Hour
	days := int(d / (24 * time.Hour))
	d -= time.Duration(days) * 24 * time.Hour
	h, m, s := int(d/time.Hour), int(d%time.Hour/time.Minute), int(d%time.Minute/time.Second)
	out := ""
	if w > 0 {
		out += fmt.Sprintf("%dw", w)
	}
	if days > 0 {
		out += fmt.Sprintf("%dd", days)
	}
	return out + fmt.Sprintf("%02d:%02d:%02d", h, m, s)
}

// NewCert gives the router a new self-signed certificate and returns its pin.
func (r *RouterOS) NewCert() (string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "edge-1"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	r.cert = tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	r.mu.Unlock()
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:]), nil
}

func (r *RouterOS) tlsConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		c := r.cert
		return &c, nil
	}}
}

// ServeREST serves the REST API over HTTPS on addr and returns its address.
func (r *RouterOS) ServeREST(ctx context.Context, addr string) (string, error) {
	if r.cert.Certificate == nil {
		if _, err := r.NewCert(); err != nil {
			return "", err
		}
	}
	ln, err := tls.Listen("tcp", addr, r.tlsConfig())
	if err != nil {
		return "", err
	}
	srv := &http.Server{Handler: http.HandlerFunc(r.serveHTTP), ReadHeaderTimeout: 5 * time.Second}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr().String(), nil
}

func (r *RouterOS) serveHTTP(w http.ResponseWriter, req *http.Request) {
	u, p, ok := req.BasicAuth()
	if !ok || u != r.User || p != r.Password {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":401,"message":"Unauthorized"}`)
		return
	}
	path := strings.TrimPrefix(req.URL.Path, "/rest/")
	w.Header().Set("Content-Type", "application/json")
	switch {
	case req.Method == http.MethodGet:
		rows, ok := r.menu(path)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":404,"message":"Not Found"}`)
			return
		}
		rows = filter(rows, req.URL.Query())
		if path == "system/identity" || path == "system/resource" || path == "system/routerboard" || path == "system/package/update" {
			_ = json.NewEncoder(w).Encode(rows[0])
			return
		}
		_ = json.NewEncoder(w).Encode(rows)
	case req.Method == http.MethodPost && path == "interface/ethernet/monitor":
		var body map[string]string
		_ = json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body)
		_ = json.NewEncoder(w).Encode(r.monitor(strings.Split(body["numbers"], ",")))
	default:
		r.Writes.Add(1)
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":403,"message":"not allowed (read-only user)"}`)
	}
}

// filter applies a REST query: ".proplist" keeps those fields, others match a field.
func filter(rows []map[string]string, q map[string][]string) []map[string]string {
	if len(q) == 0 {
		return rows
	}
	var keep []string
	if p := q[".proplist"]; len(p) > 0 {
		keep = strings.Split(p[0], ",")
	}
	var out []map[string]string
	for _, row := range rows {
		match := true
		for k, v := range q {
			if !strings.HasPrefix(k, ".") && row[k] != v[0] {
				match = false
			}
		}
		if !match {
			continue
		}
		if keep != nil {
			m := map[string]string{}
			for _, k := range keep {
				if v, ok := row[k]; ok {
					m[k] = v
				}
			}
			row = m
		}
		out = append(out, row)
	}
	return out
}

// ServeAPI serves the RouterOS API on addr, over TLS (API-SSL) or plain.
func (r *RouterOS) ServeAPI(ctx context.Context, addr string, useTLS bool) (string, error) {
	var ln net.Listener
	var err error
	if useTLS {
		if r.cert.Certificate == nil {
			if _, err := r.NewCert(); err != nil {
				return "", err
			}
		}
		ln, err = tls.Listen("tcp", addr, r.tlsConfig())
	} else {
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		return "", err
	}
	go func() { <-ctx.Done(); _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go r.serveAPI(c)
		}
	}()
	return ln.Addr().String(), nil
}

func (r *RouterOS) serveAPI(c net.Conn) {
	defer func() { _ = c.Close() }()
	rd := bufio.NewReader(c)
	logged := false
	for {
		_ = c.SetDeadline(time.Now().Add(time.Minute))
		words, err := readSentence(rd)
		if err != nil {
			return
		}
		if len(words) == 0 {
			continue
		}
		cmd, args := words[0], map[string]string{}
		query := map[string][]string{}
		for _, w := range words[1:] {
			if strings.HasPrefix(w, "=") {
				k, v, _ := strings.Cut(w[1:], "=")
				args[k] = v
				if strings.HasPrefix(k, ".") {
					query[k] = []string{v}
				}
			} else if strings.HasPrefix(w, "?") {
				k, v, _ := strings.Cut(w[1:], "=")
				query[k] = []string{v}
			}
		}
		switch {
		case cmd == "/login":
			if args["name"] != r.User || args["password"] != r.Password {
				_ = writeSentence(c, "!trap", "=message=invalid user name or password (6)")
				_ = writeSentence(c, "!done")
				continue
			}
			logged = true
			_ = writeSentence(c, "!done")
		case !logged:
			_ = writeSentence(c, "!fatal", "not logged in")
			return
		case strings.HasSuffix(cmd, "/print"):
			rows, ok := r.menu(strings.TrimSuffix(strings.TrimPrefix(cmd, "/"), "/print"))
			if !ok {
				_ = writeSentence(c, "!trap", "=message=no such command prefix")
				_ = writeSentence(c, "!done")
				continue
			}
			for _, row := range filter(rows, query) {
				words := []string{"!re"}
				for k, v := range row {
					words = append(words, "="+k+"="+v)
				}
				_ = writeSentence(c, words...)
			}
			_ = writeSentence(c, "!done")
		case cmd == "/interface/ethernet/monitor":
			for _, row := range r.monitor(strings.Split(args["numbers"], ",")) {
				words := []string{"!re"}
				for k, v := range row {
					words = append(words, "="+k+"="+v)
				}
				_ = writeSentence(c, words...)
			}
			_ = writeSentence(c, "!done")
		default:
			r.Writes.Add(1)
			_ = writeSentence(c, "!trap", "=message=not enough permissions (9)")
			_ = writeSentence(c, "!done")
		}
	}
}

// The API's word format (the client has its own; the fake keeps its own copy so the two
// are checked against each other).
func writeSentence(w io.Writer, words ...string) error {
	for _, word := range append(words, "") {
		n := len(word)
		var b []byte
		switch {
		case n < 0x80:
			b = []byte{byte(n)}
		case n < 0x4000:
			b = []byte{byte(n>>8) | 0x80, byte(n)}
		case n < 0x200000:
			b = []byte{byte(n>>16) | 0xC0, byte(n >> 8), byte(n)}
		default:
			b = []byte{byte(n>>24) | 0xE0, byte(n >> 16), byte(n >> 8), byte(n)}
		}
		if _, err := w.Write(append(b, word...)); err != nil {
			return err
		}
	}
	return nil
}

func readSentence(r *bufio.Reader) ([]string, error) {
	var out []string
	for {
		c, err := r.ReadByte()
		if err != nil {
			return nil, err
		}
		var n int
		switch {
		case c&0x80 == 0:
			n = int(c)
		case c&0xC0 == 0x80:
			b, _ := r.ReadByte()
			n = int(c&0x3F)<<8 | int(b)
		case c&0xE0 == 0xC0:
			var b [2]byte
			_, _ = io.ReadFull(r, b[:])
			n = int(c&0x1F)<<16 | int(b[0])<<8 | int(b[1])
		case c&0xF0 == 0xE0:
			var b [3]byte
			_, _ = io.ReadFull(r, b[:])
			n = int(c&0x0F)<<24 | int(b[0])<<16 | int(b[1])<<8 | int(b[2])
		default:
			var b [4]byte
			_, _ = io.ReadFull(r, b[:])
			n = int(binary.BigEndian.Uint32(b[:]))
		}
		if n > 1<<20 {
			return nil, errors.New("word too long")
		}
		if n == 0 {
			return out, nil
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		out = append(out, string(buf))
	}
}
