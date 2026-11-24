// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RouterOS timing: the same 5 seconds as SNMP for each request.
const ROSTimeout = 5 * time.Second

var (
	// ErrCertChanged: the device's certificate isn't the one pinned on first contact.
	ErrCertChanged = errors.New("the device's certificate changed since it was first seen")
	// ErrPlainRefused: the plain API (8728) without the owner's "allow unencrypted".
	ErrPlainRefused = errors.New("the plain RouterOS API sends the password in clear; it's used only when allowed for this device")
	errROSAuth      = errors.New("the router refused the RouterOS user")
	// errNotRead: a path the client doesn't read. WatchLog only prints.
	errNotRead = errors.New("not a RouterOS path WatchLog reads")
)

// CertChangedError is ErrCertChanged with the certificate seen, for the Owner to accept.
type CertChangedError struct{ Seen string }

func (e *CertChangedError) Error() string   { return ErrCertChanged.Error() }
func (e *CertChangedError) Is(t error) bool { return t == ErrCertChanged }

// certChanged finds the error in a TLS failure (wrapped by net/http or crypto/tls).
func certChanged(err error, seen string) error {
	var c *CertChangedError
	if errors.As(err, &c) {
		return c
	}
	if err != nil && strings.Contains(err.Error(), ErrCertChanged.Error()) {
		return &CertChangedError{Seen: seen}
	}
	return nil
}

// ROS is a RouterOS connection that can only read: print a menu, or run the one monitor
// command (interface/ethernet/monitor once), which RouterOS runs with the read policy.
type ROS interface {
	Print(ctx context.Context, path string) ([]map[string]string, error)
	Monitor(ctx context.Context, ids []string) ([]map[string]string, error)
	// Fingerprint is the certificate's SHA-256 as seen ("" on the plain API).
	Fingerprint() string
	Transport() string
	Close() error
}

// rosPaths are the only menus a ROS prints.
var rosPaths = map[string]bool{}

func init() {
	for _, p := range []string{
		"system/identity", "system/resource", "system/routerboard", "system/health", "interface",
		"interface/ethernet", "ip/neighbor", "ip/arp", "interface/bridge/host", "ip/route",
		"system/package/update", "interface/vlan", "interface/bridge/vlan",
	} {
		rosPaths[p] = true
	}
}

const rosMonitor = "interface/ethernet/monitor"

// apiSSLPort is where the REST fallback looks for API-SSL (tests move it).
var apiSSLPort = 8729

// pinVerifier checks the leaf certificate against pin ("" on first contact: anything, and
// the fingerprint is kept for the report).
func pinVerifier(pin string, seen *string) func(tls.ConnectionState) error {
	return func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 {
			return errors.New("no certificate")
		}
		sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
		fp := hex.EncodeToString(sum[:])
		*seen = fp
		if pin != "" && !strings.EqualFold(pin, fp) {
			return &CertChangedError{Seen: fp}
		}
		return nil
	}
}

// tlsConfig trusts the pinned certificate only: RouterOS's are usually self-signed, so the
// chain isn't checked, the pin is.
func tlsConfig(pin string, seen *string) *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // G402: the certificate is pinned (VerifyConnection), ADR-233
		MinVersion:         tls.VersionTLS12,
		VerifyConnection:   pinVerifier(pin, seen),
	}
}

// DialROS connects with the device's transport: REST over HTTPS, falling back to API-SSL;
// the plain API only when allowed.
func DialROS(ctx context.Context, address string, c *ROSCred) (ROS, error) {
	if c == nil {
		return nil, errors.New("no RouterOS credential")
	}
	// An address with its own port ("10.0.0.1:8443") is the transport's port.
	if h, p, ok := hostPort(address); ok {
		cc := *c
		cc.Port = int(p)
		address, c = h, &cc
	}
	switch c.Transport {
	case "api":
		if !c.AllowPlain {
			return nil, ErrPlainRefused
		}
		return dialAPI(ctx, address, portOr(c.Port, 8728), c, false)
	case "api-ssl":
		return dialAPI(ctx, address, portOr(c.Port, 8729), c, true)
	}
	r, err := dialREST(ctx, address, portOr(c.Port, 443), c)
	if err == nil || errors.Is(err, ErrCertChanged) || errors.Is(err, errROSAuth) {
		return r, err
	}
	// No REST (RouterOS 6, or www-ssl off): API-SSL on its own port.
	if r2, err2 := dialAPI(ctx, address, apiSSLPort, c, true); err2 == nil || errors.Is(err2, ErrCertChanged) || errors.Is(err2, errROSAuth) {
		return r2, err2
	}
	return nil, err
}

func portOr(p, def int) int {
	if p > 0 && p < 65536 {
		return p
	}
	return def
}

// restROS reads over the REST API (RouterOS 7).
type restROS struct {
	base   string
	cred   *ROSCred
	client *http.Client
	fp     string
	mu     sync.Mutex
}

func dialREST(ctx context.Context, address string, port int, c *ROSCred) (*restROS, error) {
	r := &restROS{base: "https://" + net.JoinHostPort(address, strconv.Itoa(port)) + "/rest/", cred: c}
	tr := &http.Transport{
		TLSClientConfig:     tlsConfig(c.Pin, &r.fp),
		MaxIdleConnsPerHost: 2,
		MaxConnsPerHost:     2, // at most 2 requests in flight per device
		TLSHandshakeTimeout: ROSTimeout,
		DialContext:         (&net.Dialer{Timeout: ROSTimeout}).DialContext,
	}
	r.client = &http.Client{Transport: tr, Timeout: 3 * ROSTimeout}
	if _, err := r.Print(ctx, "system/identity"); err != nil {
		tr.CloseIdleConnections()
		return nil, err
	}
	return r, nil
}

func (r *restROS) Fingerprint() string { r.mu.Lock(); defer r.mu.Unlock(); return r.fp }
func (r *restROS) Transport() string   { return "rest" }
func (r *restROS) Close() error {
	r.client.CloseIdleConnections()
	return nil
}

// maxROSBody bounds one answer (a full routing table isn't read whole).
const maxROSBody = 8 << 20

func (r *restROS) do(ctx context.Context, method, path string, body []byte) ([]map[string]string, error) {
	req, err := http.NewRequestWithContext(ctx, method, r.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(r.cred.User, r.cred.Password)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := r.client.Do(req)
	if err != nil {
		if c := certChanged(err, r.Fingerprint()); c != nil {
			return nil, c
		}
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxROSBody+1))
	if err != nil {
		return nil, err
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return nil, errROSAuth
	case res.StatusCode >= 300:
		return nil, fmt.Errorf("RouterOS REST %s answered %d", path, res.StatusCode)
	case len(data) > maxROSBody:
		return nil, fmt.Errorf("RouterOS REST %s: answer too large", path)
	}
	return decodeROS(data)
}

// decodeROS reads an object or a list of objects whose values are strings (RouterOS sends
// every value as a string).
func decodeROS(data []byte) ([]map[string]string, error) {
	data = bytes.TrimSpace(data)
	if len(data) > 0 && data[0] == '{' {
		data = append(append([]byte{'['}, data...), ']')
	}
	var raw []map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	out := make([]map[string]string, len(raw))
	for i, o := range raw {
		m := make(map[string]string, len(o))
		for k, v := range o {
			switch x := v.(type) {
			case string:
				m[k] = x
			case nil:
			default:
				m[k] = fmt.Sprint(x)
			}
		}
		out[i] = m
	}
	return out, nil
}

func (r *restROS) Print(ctx context.Context, path string) ([]map[string]string, error) {
	p, q, _ := strings.Cut(path, "?")
	if !rosPaths[p] {
		return nil, errNotRead
	}
	if q != "" {
		vals, err := url.ParseQuery(q)
		if err != nil {
			return nil, err
		}
		p += "?" + vals.Encode()
	}
	return r.do(ctx, http.MethodGet, p, nil)
}

func (r *restROS) Monitor(ctx context.Context, ids []string) ([]map[string]string, error) {
	body, _ := json.Marshal(map[string]string{"numbers": strings.Join(ids, ","), "once": ""})
	return r.do(ctx, http.MethodPost, rosMonitor, body)
}

// apiROS reads over the RouterOS API (API-SSL, or plain when allowed). One command at a time.
type apiROS struct {
	conn net.Conn
	rd   *bufio.Reader
	fp   string
	tls  bool
	mu   sync.Mutex
}

func dialAPI(ctx context.Context, address string, port int, c *ROSCred, useTLS bool) (*apiROS, error) {
	d := &net.Dialer{Timeout: ROSTimeout}
	addr := net.JoinHostPort(address, strconv.Itoa(port))
	a := &apiROS{tls: useTLS}
	var conn net.Conn
	var err error
	if useTLS {
		conn, err = (&tls.Dialer{NetDialer: d, Config: tlsConfig(c.Pin, &a.fp)}).DialContext(ctx, "tcp", addr)
		if c := certChanged(err, a.fp); c != nil {
			return nil, c
		}
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	a.conn, a.rd = conn, bufio.NewReader(conn)
	if _, err := a.run(ctx, "/login", "=name="+c.User, "=password="+c.Password); err != nil {
		_ = conn.Close()
		if !errors.Is(err, errROSAuth) {
			err = fmt.Errorf("%w: %v", errROSAuth, err)
		}
		return nil, err
	}
	return a, nil
}

func (a *apiROS) Fingerprint() string { return a.fp }
func (a *apiROS) Transport() string {
	if a.tls {
		return "api-ssl"
	}
	return "api"
}
func (a *apiROS) Close() error { return a.conn.Close() }

// run sends one command and reads its replies up to !done.
func (a *apiROS) run(ctx context.Context, words ...string) ([]map[string]string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	dl := time.Now().Add(3 * ROSTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(dl) {
		dl = d
	}
	_ = a.conn.SetDeadline(dl)
	if err := WriteSentence(a.conn, words...); err != nil {
		return nil, err
	}
	var out []map[string]string
	size := 0
	for {
		sent, err := ReadSentence(a.rd)
		if err != nil {
			return nil, err
		}
		if len(sent) == 0 {
			continue
		}
		switch sent[0] {
		case "!re":
			out = append(out, attrs(sent[1:]))
			if size += len(sent); size > 1_000_000 {
				return nil, errors.New("RouterOS API: answer too large")
			}
		case "!done":
			return out, nil
		case "!trap":
			msg := attrs(sent[1:])["message"]
			if words[0] == "/login" {
				return nil, fmt.Errorf("%w: %s", errROSAuth, msg)
			}
			return nil, fmt.Errorf("RouterOS API: %s", msg)
		case "!fatal":
			return nil, fmt.Errorf("RouterOS API: %s", strings.Join(sent[1:], " "))
		}
	}
}

func (a *apiROS) Print(ctx context.Context, path string) ([]map[string]string, error) {
	p, q, _ := strings.Cut(path, "?")
	if !rosPaths[p] {
		return nil, errNotRead
	}
	words := []string{"/" + p + "/print"}
	if q != "" {
		vals, err := url.ParseQuery(q)
		if err != nil {
			return nil, err
		}
		for k, v := range vals {
			if strings.HasPrefix(k, ".") { // .proplist
				words = append(words, "="+k+"="+strings.Join(v, ","))
			} else {
				words = append(words, "?"+k+"="+v[0])
			}
		}
	}
	return a.run(ctx, words...)
}

func (a *apiROS) Monitor(ctx context.Context, ids []string) ([]map[string]string, error) {
	return a.run(ctx, "/"+rosMonitor, "=numbers="+strings.Join(ids, ","), "=once=")
}
