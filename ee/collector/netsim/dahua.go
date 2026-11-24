// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/md5" //nolint:gosec // G501: the recorder's HTTP digest is MD5
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
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

// Dahua is a fake Dahua recorder (NVR): the HTTP API's read calls WatchLog makes, behind HTTP
// digest authentication, and the event stream (eventManager attach). Sixteen cameras and two
// disks, a local one and an iSCSI one. It refuses anything else and counts the attempts.
type Dahua struct {
	User, Password string
	Serial, Name   string
	Model, Version string
	MAC            string
	Clock          func() time.Time
	// HeartbeatEvery overrides the stream's heartbeat (the request's heartbeat=N seconds).
	HeartbeatEvery time.Duration
	// RefuseCodeList answers 400 to an attach that lists codes (firmware that wants [All]).
	RefuseCodeList bool
	// OneTimeNonce closes each connection and accepts a nonce once, as some recorders do.
	OneTimeNonce bool

	Writes   atomic.Int64 // requests that weren't reads
	Attaches atomic.Int64 // attach requests, refused ones too
	// Challenges counts the 401s sent (a client that reuses the nonce sends one).
	Challenges atomic.Int64

	mu      sync.Mutex
	cams    []bool
	titles  []string
	disks   []nvrDisk
	nonces  map[string]bool
	streams map[*nvrStream]struct{}
	cert    tls.Certificate
}

type nvrDisk struct {
	name    string
	iscsi   bool
	present bool
	total   float64
	used    float64
}

type nvrStream struct {
	all   bool
	codes map[string]bool
	out   chan string
	drop  chan struct{}
}

// NVR is the demo's recorder, nvr-1: sixteen cameras (cam-1 ... cam-16 on channels 0..15), a
// local 2 TB disk and a 16 TB iSCSI disk on the NAS.
func NVR() *Dahua {
	d := &Dahua{
		User: "watchlog", Password: "read-only-sample", Serial: "8L0ABC1234567", Name: "nvr-1",
		Model: "DHI-NVR5216-16P-4KS2E", Version: "4.001.0000000.3.R,build:2023-08-17", MAC: "3C:EF:8C:01:02:03",
		nonces: map[string]bool{}, streams: map[*nvrStream]struct{}{},
	}
	for i := 0; i < 16; i++ {
		d.cams = append(d.cams, true)
		d.titles = append(d.titles, fmt.Sprintf("cam-%d", i+1))
	}
	d.disks = []nvrDisk{
		{name: "/dev/sda", present: true, total: 1_995_000_000_000, used: 1_412_000_000_000},
		{name: "/dev/iscsi0", iscsi: true, present: true, total: 15_990_000_000_000, used: 9_870_000_000_000},
	}
	return d
}

func (d *Dahua) now() time.Time {
	if d.Clock != nil {
		return d.Clock()
	}
	return time.Now()
}

// SetCamera takes a camera off or back on line; the stream says VideoLoss Start or Stop.
func (d *Dahua) SetCamera(channel int, online bool) {
	d.mu.Lock()
	if channel < 0 || channel >= len(d.cams) || d.cams[channel] == online {
		d.mu.Unlock()
		return
	}
	d.cams[channel] = online
	d.mu.Unlock()
	d.Emit("VideoLoss", startStop(!online), channel)
}

// SetISCSI loses or restores the iSCSI disk: lost, its state is Error and it reads no bytes;
// the stream says StorageNotExist Start or Stop (index: the disk's place in the list).
func (d *Dahua) SetISCSI(present bool) {
	d.mu.Lock()
	idx := -1
	for i := range d.disks {
		if d.disks[i].iscsi && d.disks[i].present != present {
			d.disks[i].present, idx = present, i
		}
	}
	d.mu.Unlock()
	if idx >= 0 {
		d.Emit("StorageNotExist", startStop(!present), idx)
	}
}

// SetUsed sets a disk's used bytes (by name); at 95 % the stream says StorageLowSpace Start,
// below it Stop.
func (d *Dahua) SetUsed(name string, used float64) {
	d.mu.Lock()
	idx, was, is := -1, false, false
	for i := range d.disks {
		if dk := &d.disks[i]; dk.name == name {
			was = dk.used >= 0.95*dk.total
			dk.used = min(used, dk.total)
			is, idx = dk.used >= 0.95*dk.total, i
		}
	}
	d.mu.Unlock()
	if idx >= 0 && was != is {
		d.Emit("StorageLowSpace", startStop(is), idx)
	}
}

// ISCSIName is the iSCSI disk's name (for SetUsed).
const ISCSIName = "/dev/iscsi0"

func startStop(start bool) string {
	if start {
		return "Start"
	}
	return "Stop"
}

// Emit sends an event to the open streams that asked for its code.
func (d *Dahua) Emit(code, action string, index int) {
	payload := fmt.Sprintf("Code=%s;action=%s;index=%d", code, action, index)
	if code == "VideoLoss" || code == "VideoMotion" {
		payload += ";data={\r\n   \"LocaleTime\" : \"" + d.now().Format("2006-01-02 15:04:05") + "\"\r\n}"
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for s := range d.streams {
		if s.all || s.codes[code] {
			select {
			case s.out <- payload:
			default: // a slow reader misses it, as on a recorder
			}
		}
	}
}

// DropStreams ends the open event streams (the client reconnects).
func (d *Dahua) DropStreams() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for s := range d.streams {
		close(s.drop)
		delete(d.streams, s)
	}
}

// Streams is the number of open event streams.
func (d *Dahua) Streams() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.streams)
}

// NewCert gives the recorder a new self-signed certificate and returns its pin.
func (d *Dahua) NewCert() (string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: d.Name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	d.cert = tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	d.mu.Unlock()
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:]), nil
}

// Serve serves the API on addr, over HTTPS when useTLS, and returns its address.
func (d *Dahua) Serve(ctx context.Context, addr string, useTLS bool) (string, error) {
	var ln net.Listener
	var err error
	if useTLS {
		if d.cert.Certificate == nil {
			if _, err := d.NewCert(); err != nil {
				return "", err
			}
		}
		ln, err = tls.Listen("tcp", addr, &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			d.mu.Lock()
			defer d.mu.Unlock()
			c := d.cert
			return &c, nil
		}})
	} else {
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		return "", err
	}
	srv := &http.Server{Handler: http.HandlerFunc(d.serveHTTP), ReadHeaderTimeout: 5 * time.Second}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr().String(), nil
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s)) //nolint:gosec // G401: HTTP digest
	return hex.EncodeToString(sum[:])
}

func (d *Dahua) realm() string { return "Login to " + d.Serial }

func (d *Dahua) challenge(w http.ResponseWriter) {
	d.Challenges.Add(1)
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	nonce := hex.EncodeToString(raw[:])
	d.mu.Lock()
	if len(d.nonces) > 1024 {
		d.nonces = map[string]bool{}
	}
	d.nonces[nonce] = true
	d.mu.Unlock()
	w.Header().Add("WWW-Authenticate", fmt.Sprintf(`Digest realm=%q, qop="auth", nonce=%q, opaque=%q`, d.realm(), nonce, md5hex(nonce)[:16]))
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = io.WriteString(w, "Error\r\nInvalid Authority!\r\n")
}

// authorized checks a Digest answer (MD5, qop=auth).
func (d *Dahua) authorized(r *http.Request) bool {
	scheme, rest, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Digest") {
		return false
	}
	p := map[string]string{}
	for _, f := range splitParams(rest) {
		k, v, _ := strings.Cut(f, "=")
		p[strings.ToLower(strings.TrimSpace(k))] = strings.Trim(strings.TrimSpace(v), `"`)
	}
	d.mu.Lock()
	known := d.nonces[p["nonce"]]
	if known && d.OneTimeNonce {
		delete(d.nonces, p["nonce"])
	}
	d.mu.Unlock()
	if !known || p["username"] != d.User || p["realm"] != d.realm() || p["uri"] != r.RequestURI || p["qop"] != "auth" {
		return false
	}
	ha1 := md5hex(d.User + ":" + d.realm() + ":" + d.Password)
	ha2 := md5hex(r.Method + ":" + p["uri"])
	return p["response"] == md5hex(ha1+":"+p["nonce"]+":"+p["nc"]+":"+p["cnonce"]+":auth:"+ha2)
}

// splitParams splits a=1, b="x, y" at the commas outside quotes.
func splitParams(s string) []string {
	var out []string
	quoted, start := false, 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			quoted = !quoted
		case ',':
			if !quoted {
				out = append(out, s[start:i])
				start = i + 1
			}
		}
	}
	return append(out, s[start:])
}

func (d *Dahua) serveHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	call := r.URL.Path + "?" + q.Get("action")
	reads := map[string]bool{
		"/cgi-bin/magicBox.cgi?getDeviceType": true, "/cgi-bin/magicBox.cgi?getSerialNo": true,
		"/cgi-bin/magicBox.cgi?getSoftwareVersion": true, "/cgi-bin/magicBox.cgi?getMachineName": true,
		"/cgi-bin/magicBox.cgi?getUpTime": true, "/cgi-bin/storageDevice.cgi?getDeviceAllInfo": true,
		"/cgi-bin/LogicDeviceManager.cgi?getCameraState": true, "/cgi-bin/eventManager.cgi?attach": true,
	}
	if call == "/cgi-bin/configManager.cgi?getConfig" && (q.Get("name") == "ChannelTitle" || q.Get("name") == "Network") {
		reads[call] = true
	}
	if r.Method != http.MethodGet || !reads[call] {
		d.Writes.Add(1)
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "Error\r\nBad Request!\r\n")
		return
	}
	if d.OneTimeNonce {
		w.Header().Set("Connection", "close")
	}
	if !d.authorized(r) {
		d.challenge(w)
		return
	}
	if call == "/cgi-bin/eventManager.cgi?attach" {
		d.attach(w, r)
		return
	}
	if q.Get("name") == "Network" {
		call += "&Network"
	}
	body, status := d.answer(call)
	w.Header().Set("Content-Type", "text/plain;charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func (d *Dahua) answer(call string) (string, int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var b strings.Builder
	line := func(k string, v any) { fmt.Fprintf(&b, "%s=%v\r\n", k, v) }
	switch call {
	case "/cgi-bin/magicBox.cgi?getDeviceType":
		line("type", d.Model)
	case "/cgi-bin/magicBox.cgi?getSerialNo":
		line("sn", d.Serial)
	case "/cgi-bin/magicBox.cgi?getSoftwareVersion":
		line("version", d.Version)
	case "/cgi-bin/magicBox.cgi?getMachineName":
		line("name", d.Name)
	case "/cgi-bin/magicBox.cgi?getUpTime":
		// Unconfirmed call: answered as a recorder answers one it doesn't have.
		return "Error\r\nBad Request!\r\n", http.StatusBadRequest
	case "/cgi-bin/storageDevice.cgi?getDeviceAllInfo":
		for i, dk := range d.disks {
			p := fmt.Sprintf("list.info[%d].", i)
			state, total, used := "Success", dk.total, dk.used
			if !dk.present {
				state, total, used = "Error", 0, 0
			}
			line(p+"Detail[0].FreeBytes", fmt.Sprintf("%.6f", total-used))
			line(p+"Detail[0].IsError", strconv.FormatBool(!dk.present))
			line(p+"Detail[0].Path", dk.name+"1")
			line(p+"Detail[0].TotalBytes", fmt.Sprintf("%.6f", total))
			line(p+"Detail[0].Type", "ReadWrite")
			line(p+"Detail[0].UsedBytes", fmt.Sprintf("%.6f", used))
			line(p+"Name", dk.name)
			line(p+"State", state)
		}
	case "/cgi-bin/LogicDeviceManager.cgi?getCameraState":
		for i, on := range d.cams {
			st := "Connected"
			if !on {
				st = "Disconnected"
			}
			line(fmt.Sprintf("states[%d].channel", i), i)
			line(fmt.Sprintf("states[%d].connectionState", i), st)
		}
	case "/cgi-bin/configManager.cgi?getConfig&Network":
		// Inferred format (no published answer seen).
		line("table.Network.DefaultInterface", "eth0")
		line("table.Network.Domain", "dahua")
		line("table.Network.Hostname", d.Name)
		line("table.Network.eth0.DefaultGateway", "10.0.30.1")
		line("table.Network.eth0.DhcpEnable", "false")
		line("table.Network.eth0.IPAddress", "10.0.30.10")
		line("table.Network.eth0.MTU", 1500)
		line("table.Network.eth0.PhysicalAddress", d.MAC)
		line("table.Network.eth0.SubnetMask", "255.255.255.0")
	case "/cgi-bin/configManager.cgi?getConfig":
		for i, t := range d.titles {
			line(fmt.Sprintf("table.ChannelTitle[%d].Name", i), t)
		}
	}
	return b.String(), http.StatusOK
}

// attach serves the event stream: multipart/x-mixed-replace, boundary "myboundary", one
// part per event and a "Heartbeat" part every heartbeat.
func (d *Dahua) attach(w http.ResponseWriter, r *http.Request) {
	d.Attaches.Add(1)
	codes := strings.Trim(r.URL.Query().Get("codes"), "[]")
	s := &nvrStream{codes: map[string]bool{}, out: make(chan string, 64), drop: make(chan struct{})}
	for _, c := range strings.Split(codes, ",") {
		if c == "All" {
			s.all = true
		}
		s.codes[c] = true
	}
	if d.RefuseCodeList && !s.all {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "Error\r\nBad Request!\r\n")
		return
	}
	every := d.HeartbeatEvery
	if every <= 0 {
		n, _ := strconv.Atoi(r.URL.Query().Get("heartbeat"))
		every = time.Duration(max(n, 1)) * time.Second
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	d.mu.Lock()
	d.streams[s] = struct{}{}
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.streams, s)
		d.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=myboundary")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	send := func(payload string) bool {
		body := payload + "\r\n"
		_, err := fmt.Fprintf(w, "--myboundary\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n%s\r\n", len(body), body)
		fl.Flush()
		return err == nil
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.drop:
			return
		case p := <-s.out:
			if !send(p) {
				return
			}
		case <-t.C:
			if !send("Heartbeat") {
				return
			}
		}
	}
}
