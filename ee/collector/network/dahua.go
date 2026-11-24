// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5" //nolint:gosec // G501: HTTP digest (RFC 7616) as Dahua recorders speak it is MD5
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Dahua recorders (NVRs, 0.17, ADR-234) are read over their HTTP API ("CGI") with a
// read-only user and HTTP digest authentication, over HTTP or HTTPS with the certificate
// pinned on first contact as RouterOS's is. The client reads a fixed list of paths and
// holds one event stream per recorder (eventManager attach).

// DahuaTimeout bounds each request (the stream has its own read timeout).
const DahuaTimeout = 5 * time.Second

var (
	errDahuaAuth = errors.New("the recorder refused the user")
	// errDahuaPath: a path the client doesn't read. WatchLog only reads.
	errDahuaPath = errors.New("not a Dahua path WatchLog reads")
)

// dahuaStatusError is an answer that isn't a 200, or a 200 whose body is "Error": the call
// isn't there on this firmware, which isn't the recorder being down.
type dahuaStatusError struct {
	Code int
	Path string
}

func (e *dahuaStatusError) Error() string {
	p, _, _ := strings.Cut(e.Path, "&")
	return fmt.Sprintf("the recorder answered %d to %s", e.Code, p)
}

// The event codes the stream asks for; with the [All] fallback the rest are dropped here.
var dahuaCodes = []string{"StorageFailure", "StorageNotExist", "StorageLowSpace", "RecordFailure", "NetAbort", "VideoLoss"}

// dahuaHeartbeat is the stream's heartbeat in seconds; the read timeout is three of them.
const dahuaHeartbeat = 5

// The only paths the client sends.
const (
	dahuaDeviceType   = "/cgi-bin/magicBox.cgi?action=getDeviceType"
	dahuaSerial       = "/cgi-bin/magicBox.cgi?action=getSerialNo"
	dahuaVersion      = "/cgi-bin/magicBox.cgi?action=getSoftwareVersion"
	dahuaMachineName  = "/cgi-bin/magicBox.cgi?action=getMachineName"
	dahuaUptime       = "/cgi-bin/magicBox.cgi?action=getUpTime"
	dahuaStorage      = "/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo"
	dahuaCameraState  = "/cgi-bin/LogicDeviceManager.cgi?action=getCameraState&uniqueChannels[0]=-1"
	dahuaChannelTitle = "/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle"
	dahuaNetwork      = "/cgi-bin/configManager.cgi?action=getConfig&name=Network"
)

var (
	dahuaAttachList = "/cgi-bin/eventManager.cgi?action=attach&codes=[" + strings.Join(dahuaCodes, ",") + "]&heartbeat=" + strconv.Itoa(dahuaHeartbeat)
	dahuaAttachAll  = "/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=" + strconv.Itoa(dahuaHeartbeat)
	dahuaPaths      = map[string]bool{
		dahuaDeviceType: true, dahuaSerial: true, dahuaVersion: true, dahuaMachineName: true, dahuaUptime: true,
		dahuaStorage: true, dahuaCameraState: true, dahuaChannelTitle: true, dahuaNetwork: true, dahuaAttachList: true, dahuaAttachAll: true,
	}
)

// DahuaDialFunc makes a recorder's client; tests pass their own.
type DahuaDialFunc func(ctx context.Context, address string, c *DahuaCred) (*Dahua, error)

// Dahua is a recorder's HTTP API client that can only GET the paths above.
type Dahua struct {
	base   string
	user   string
	pass   string
	client *http.Client // requests, with a timeout
	stream *http.Client // the event stream, without one
	tr     *http.Transport

	mu sync.Mutex
	fp string
	// The last digest challenge, reused (nc counts up) until the recorder sends a new one.
	ch *digestChallenge
	nc uint32
}

// DialDahua makes a client for the recorder at address ("host" or "host:port"). It doesn't
// connect: the first request does.
func DialDahua(_ context.Context, address string, c *DahuaCred) (*Dahua, error) {
	if c == nil {
		return nil, errors.New("no Dahua credential")
	}
	port := c.Port
	if h, p, ok := hostPort(address); ok {
		address, port = h, int(p)
	}
	scheme, def := "http", 80
	if c.HTTPS {
		scheme, def = "https", 443
	}
	d := &Dahua{base: scheme + "://" + net.JoinHostPort(address, strconv.Itoa(portOr(port, def))), user: c.User, pass: c.Password}
	d.tr = &http.Transport{
		MaxIdleConnsPerHost: 2,
		MaxConnsPerHost:     2,
		TLSHandshakeTimeout: DahuaTimeout,
		DialContext:         (&net.Dialer{Timeout: DahuaTimeout}).DialContext,
	}
	if c.HTTPS {
		pin := c.Pin
		d.tr.TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true, //nolint:gosec // G402: the certificate is pinned (VerifyConnection), ADR-233
			MinVersion:         tls.VersionTLS12,
			VerifyConnection: func(cs tls.ConnectionState) error {
				var seen string
				err := pinVerifier(pin, &seen)(cs)
				d.mu.Lock()
				d.fp = seen
				d.mu.Unlock()
				return err
			},
		}
	}
	d.client = &http.Client{Transport: d.tr, Timeout: 3 * DahuaTimeout}
	d.stream = &http.Client{Transport: d.tr}
	return d, nil
}

// Fingerprint is the certificate's SHA-256 as seen ("" over HTTP or before a request).
func (d *Dahua) Fingerprint() string { d.mu.Lock(); defer d.mu.Unlock(); return d.fp }

// Close drops the idle connections.
func (d *Dahua) Close() { d.tr.CloseIdleConnections() }

// maxDahuaBody bounds one answer.
const maxDahuaBody = 1 << 20

// Get reads one of the paths and returns the body.
func (d *Dahua) Get(ctx context.Context, path string) (string, error) {
	if path == dahuaAttachList || path == dahuaAttachAll {
		return "", errDahuaPath // the stream has its own call
	}
	res, err := d.do(ctx, d.client, path)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxDahuaBody+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxDahuaBody {
		return "", fmt.Errorf("the recorder's answer to %s is too large", path)
	}
	if res.StatusCode != http.StatusOK || bytes.HasPrefix(bytes.TrimSpace(data), []byte("Error")) {
		return "", &dahuaStatusError{Code: res.StatusCode, Path: path}
	}
	return string(data), nil
}

// attach opens the event stream; the caller reads and closes the body.
func (d *Dahua) attach(ctx context.Context, all bool) (*http.Response, error) {
	path := dahuaAttachList
	if all {
		path = dahuaAttachAll
	}
	res, err := d.do(ctx, d.stream, path)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		return nil, &dahuaStatusError{Code: res.StatusCode, Path: path}
	}
	return res, nil
}

// do sends a GET with the digest answer to the last challenge, and on a 401 once more with
// the new one (some recorders close the connection and change the nonce every time).
func (d *Dahua) do(ctx context.Context, c *http.Client, path string) (*http.Response, error) {
	if !dahuaPaths[path] {
		return nil, errDahuaPath
	}
	for try := 0; ; try++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base+path, nil)
		if err != nil {
			return nil, err
		}
		if h := d.authorization(req.URL.RequestURI()); h != "" {
			req.Header.Set("Authorization", h)
		}
		res, err := c.Do(req)
		if err != nil {
			if cc := certChanged(err, d.Fingerprint()); cc != nil {
				return nil, cc
			}
			return nil, err
		}
		if res.StatusCode != http.StatusUnauthorized {
			return res, nil
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		ch := parseChallenge(res.Header.Values("WWW-Authenticate"))
		if ch == nil || try > 0 {
			return nil, errDahuaAuth
		}
		if !strings.EqualFold(ch.algorithm, "") && !strings.EqualFold(ch.algorithm, "MD5") {
			return nil, fmt.Errorf("%w: digest algorithm %s isn't supported", errDahuaAuth, ch.algorithm)
		}
		d.mu.Lock()
		d.ch, d.nc = ch, 0
		d.mu.Unlock()
	}
}

// digestChallenge is a WWW-Authenticate: Digest header.
type digestChallenge struct {
	realm, nonce, opaque, algorithm string
	qopAuth                         bool
}

// parseChallenge finds the Digest challenge among the headers (some recorders send Basic too).
func parseChallenge(headers []string) *digestChallenge {
	for _, h := range headers {
		scheme, rest, _ := strings.Cut(strings.TrimSpace(h), " ")
		if !strings.EqualFold(scheme, "Digest") {
			continue
		}
		p := authParams(rest)
		if p["nonce"] == "" {
			continue
		}
		ch := &digestChallenge{realm: p["realm"], nonce: p["nonce"], opaque: p["opaque"], algorithm: p["algorithm"]}
		for _, q := range strings.Split(p["qop"], ",") {
			if strings.TrimSpace(q) == "auth" {
				ch.qopAuth = true
			}
		}
		return ch
	}
	return nil
}

// authParams splits `a="x, y", b=z` into its parameters.
func authParams(s string) map[string]string {
	out := map[string]string{}
	for len(s) > 0 {
		s = strings.TrimLeft(s, " ,\t")
		k, rest, ok := strings.Cut(s, "=")
		if !ok {
			break
		}
		k = strings.ToLower(strings.TrimSpace(k))
		rest = strings.TrimLeft(rest, " \t")
		var v string
		if strings.HasPrefix(rest, `"`) {
			var b strings.Builder
			i := 1
			for ; i < len(rest); i++ {
				if rest[i] == '\\' && i+1 < len(rest) {
					i++
					b.WriteByte(rest[i])
					continue
				}
				if rest[i] == '"' {
					break
				}
				b.WriteByte(rest[i])
			}
			v, s = b.String(), rest[min(i+1, len(rest)):]
		} else {
			v, s, _ = strings.Cut(rest, ",")
			v = strings.TrimSpace(v)
		}
		out[k] = v
	}
	return out
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s)) //nolint:gosec // G401: HTTP digest is MD5 on these recorders
	return hex.EncodeToString(sum[:])
}

// authorization answers the last challenge for uri ("" before the first challenge).
func (d *Dahua) authorization(uri string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	ch := d.ch
	if ch == nil {
		return ""
	}
	d.nc++
	ha1 := md5hex(d.user + ":" + ch.realm + ":" + d.pass)
	ha2 := md5hex(http.MethodGet + ":" + uri)
	var b strings.Builder
	fmt.Fprintf(&b, `Digest username=%q, realm=%q, nonce=%q, uri=%q, algorithm=MD5`, d.user, ch.realm, ch.nonce, uri)
	if ch.qopAuth {
		nc := fmt.Sprintf("%08x", d.nc)
		var raw [8]byte
		_, _ = rand.Read(raw[:])
		cnonce := hex.EncodeToString(raw[:])
		resp := md5hex(ha1 + ":" + ch.nonce + ":" + nc + ":" + cnonce + ":auth:" + ha2)
		fmt.Fprintf(&b, `, qop=auth, nc=%s, cnonce=%q, response=%q`, nc, cnonce, resp)
	} else {
		fmt.Fprintf(&b, `, response=%q`, md5hex(ha1+":"+ch.nonce+":"+ha2))
	}
	if ch.opaque != "" {
		fmt.Fprintf(&b, `, opaque=%q`, ch.opaque)
	}
	return b.String()
}

// parseKV reads a CGI answer: one key=value per line.
func parseKV(body string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		k, v, ok := strings.Cut(strings.TrimRight(line, "\r"), "=")
		if ok {
			out[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return out
}

var (
	diskKey   = regexp.MustCompile(`^list\.info\[(\d+)\]\.(.+)$`)
	detailKey = regexp.MustCompile(`^Detail\[\d+\]\.(\w+)$`)
	camKey    = regexp.MustCompile(`^(?:status\.)?states\[(\d+)\]\.(\w+)$`)
	titleKey  = regexp.MustCompile(`^table\.ChannelTitle\[(\d+)\]\.Name$`)
)

// parseDisks reads storageDevice.cgi?action=getDeviceAllInfo: each disk's name and state,
// its parts' bytes summed.
func parseDisks(body string) []RecorderDisk {
	byIdx := map[int]map[string]string{}
	for k, v := range parseKV(body) {
		m := diskKey.FindStringSubmatch(k)
		if m == nil {
			continue
		}
		i, _ := strconv.Atoi(m[1])
		if byIdx[i] == nil {
			byIdx[i] = map[string]string{}
		}
		byIdx[i][m[2]] = v
	}
	idx := make([]int, 0, len(byIdx))
	for i := range byIdx {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	out := make([]RecorderDisk, 0, len(idx))
	for _, i := range idx {
		f := byIdx[i]
		d := RecorderDisk{Name: f["Name"], State: f["State"], ISCSI: isISCSI(f)}
		d.Healthy = d.State == "Success"
		for k, v := range f {
			m := detailKey.FindStringSubmatch(k)
			if m == nil {
				continue
			}
			switch m[1] {
			case "TotalBytes":
				if x, ok := atof(v); ok {
					d.Total += x
				}
			case "UsedBytes":
				if x, ok := atof(v); ok {
					d.Used += x
				}
			case "IsError":
				if strings.EqualFold(v, "true") {
					d.Healthy = false
				}
			}
		}
		out = append(out, d)
	}
	return out
}

// isISCSI says whether a disk of getDeviceAllInfo is a network (iSCSI) disk. UNCONFIRMED: no
// published answer from a recorder with an iSCSI disk was found, so this guesses: "iscsi" in
// the disk's name or in a part's Path, Type or Name; or a name that isn't a local /dev/sd*
// disk with a key saying network (IsNet=true, Type=Net). Check it against a real recorder.
func isISCSI(fields map[string]string) bool {
	if strings.Contains(strings.ToLower(fields["Name"]), "iscsi") {
		return true
	}
	network := false
	for k, v := range fields {
		lk, lv := strings.ToLower(k), strings.ToLower(v)
		if (strings.HasSuffix(lk, ".path") || strings.HasSuffix(lk, ".type") || strings.HasSuffix(lk, ".name") || lk == "type") && strings.Contains(lv, "iscsi") {
			return true
		}
		if (strings.HasSuffix(lk, "isnet") && lv == "true") || ((lk == "type" || strings.HasSuffix(lk, ".type")) && (lv == "net" || lv == "network")) {
			network = true
		}
	}
	return network && !strings.HasPrefix(fields["Name"], "/dev/sd")
}

// parseCameras reads getCameraState (UNCONFIRMED format: states[N].channel and
// states[N].connectionState, "Connected" being online) with the channel titles. Channels
// are the recorder's own numbers (from 0), as the events' index is.
func parseCameras(states, titles string) []Camera {
	names := map[int]string{}
	for k, v := range parseKV(titles) {
		if m := titleKey.FindStringSubmatch(k); m != nil {
			n, _ := strconv.Atoi(m[1])
			names[n] = v
		}
	}
	type cam struct {
		ch    int
		state string
	}
	byIdx := map[int]*cam{}
	for k, v := range parseKV(states) {
		m := camKey.FindStringSubmatch(k)
		if m == nil {
			continue
		}
		i, _ := strconv.Atoi(m[1])
		if byIdx[i] == nil {
			byIdx[i] = &cam{ch: i}
		}
		switch strings.ToLower(m[2]) {
		case "channel":
			if n, err := strconv.Atoi(v); err == nil {
				byIdx[i].ch = n
			}
		case "connectionstate":
			byIdx[i].state = v
		}
	}
	out := make([]Camera, 0, len(byIdx))
	for _, c := range byIdx {
		out = append(out, Camera{Channel: c.ch, Name: names[c.ch], Online: strings.EqualFold(c.state, "Connected")})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Channel < out[j].Channel })
	return out
}

// dahuaEvent is one line of a stream part: Code=VideoLoss;action=Start;index=3[;data=...].
type dahuaEvent struct {
	code, action string
	index        int
}

// parseEvents reads a part's payload; lines that don't start with Code= (a heartbeat, the
// rest of a data JSON) are skipped.
func parseEvents(payload []byte) []dahuaEvent {
	var out []dahuaEvent
	for _, line := range strings.Split(string(payload), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToLower(line), "code=") {
			continue
		}
		e := dahuaEvent{index: -1}
		for _, f := range strings.Split(line, ";") {
			k, v, _ := strings.Cut(f, "=")
			switch strings.ToLower(strings.TrimSpace(k)) {
			case "code":
				e.code = v
			case "action":
				e.action = v
			case "index":
				e.index, _ = strconv.Atoi(v)
			}
			if strings.EqualFold(strings.TrimSpace(k), "data") {
				break // the JSON may hold ';'
			}
		}
		if e.code != "" {
			out = append(out, e)
		}
	}
	return out
}

// maxDahuaPart bounds one part of the stream (a data JSON is a few KB).
const maxDahuaPart = 64 << 10

var errStreamEnd = errors.New("the recorder ended the event stream")

// readMultipart reads a multipart/x-mixed-replace stream and calls part with each payload:
// headers, then Content-Length bytes, or up to the next boundary when there's none.
func readMultipart(r *bufio.Reader, boundary string, part func([]byte)) error {
	delim := "--" + strings.TrimPrefix(boundary, "--")
	isDelim := func(l string) (bool, bool) {
		switch l {
		case delim:
			return true, false
		case delim + "--":
			return true, true
		}
		return false, false
	}
	// Up to the first boundary.
	for {
		l, err := readLine(r)
		if err != nil {
			return err
		}
		if ok, end := isDelim(l); ok {
			if end {
				return errStreamEnd
			}
			break
		}
	}
	for {
		// Headers.
		length := -1
		for {
			l, err := readLine(r)
			if err != nil {
				return err
			}
			if l == "" {
				break
			}
			k, v, _ := strings.Cut(l, ":")
			if strings.EqualFold(strings.TrimSpace(k), "Content-Length") {
				if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
					length = n
				}
			}
		}
		if length >= 0 {
			if length > maxDahuaPart {
				return fmt.Errorf("an event stream part of %d bytes", length)
			}
			buf := make([]byte, length)
			if _, err := io.ReadFull(r, buf); err != nil {
				return err
			}
			part(buf)
			// Up to the next boundary (the blank line after the payload).
			for {
				l, err := readLine(r)
				if err != nil {
					return err
				}
				if ok, end := isDelim(l); ok {
					if end {
						return errStreamEnd
					}
					break
				}
			}
			continue
		}
		var buf bytes.Buffer
		for {
			l, err := readLine(r)
			if err != nil {
				return err
			}
			if ok, end := isDelim(l); ok {
				part(buf.Bytes())
				if end {
					return errStreamEnd
				}
				break
			}
			if buf.Len()+len(l) > maxDahuaPart {
				return errors.New("an event stream part without a boundary")
			}
			buf.WriteString(l)
			buf.WriteByte('\n')
		}
	}
}

// readLine reads one line without its CRLF, bounded.
func readLine(r *bufio.Reader) (string, error) {
	var b []byte
	for {
		chunk, prefix, err := r.ReadLine()
		if err != nil {
			return "", err
		}
		b = append(b, chunk...)
		if len(b) > maxDahuaPart {
			return "", errors.New("an event stream line too long")
		}
		if !prefix {
			return string(b), nil
		}
	}
}

// boundaryOf reads the stream's boundary from its Content-Type ("myboundary" when it says none).
func boundaryOf(contentType string) string {
	if _, p, err := mime.ParseMediaType(contentType); err == nil && p["boundary"] != "" {
		return p["boundary"]
	}
	return "myboundary"
}

// Stream timing.
const (
	streamBackoffFirst = time.Second
	streamBackoffMax   = 60 * time.Second
	// streamHealthy: a stream that lived this long starts the backoff over.
	streamHealthy = 60 * time.Second
	// streamAuthWait: a refused user is tried again only after this long (recorders lock a
	// user out after a few failed logins).
	streamAuthWait = 10 * time.Minute
	// maxStreamEvents bounds the events kept between two rounds.
	maxStreamEvents = 256
)

// dahuaStream holds a recorder's event stream: the events since the last round and what is
// still on.
type dahuaStream struct {
	now         func() time.Time
	sleep       func(ctx context.Context, d time.Duration) bool
	readTimeout time.Duration

	mu        sync.Mutex
	connected bool
	all       bool // the recorder refused the code list: ask for [All], filter here
	events    []RecorderEvent
	active    map[string]RecorderEvent
	cancel    context.CancelFunc
	done      chan struct{}
}

func newDahuaStream(now func() time.Time) *dahuaStream {
	if now == nil {
		now = time.Now
	}
	return &dahuaStream{now: now, sleep: sleepCtx, readTimeout: 3 * dahuaHeartbeat * time.Second, active: map[string]RecorderEvent{}}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// start runs the stream in a goroutine until stop.
func (s *dahuaStream) start(dial DahuaDialFunc, dev Device) {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel, s.done = cancel, make(chan struct{})
	go func() {
		defer close(s.done)
		s.run(ctx, dial, dev)
	}()
}

// stop ends the stream and waits for its goroutine.
func (s *dahuaStream) stop() {
	if s == nil || s.cancel == nil {
		return
	}
	s.cancel()
	<-s.done
}

// run connects, reads and reconnects with a backoff from 1 s doubling to 60 s, started over
// after a stream that lived 60 s.
func (s *dahuaStream) run(ctx context.Context, dial DahuaDialFunc, dev Device) {
	var c *Dahua
	wait := streamBackoffFirst
	for ctx.Err() == nil {
		started := s.now()
		var err error
		if c == nil {
			c, err = dial(ctx, dev.Address, dev.Dahua)
		}
		if c != nil {
			err = s.once(ctx, c)
		}
		s.setConnected(false)
		if ctx.Err() != nil {
			break
		}
		if s.now().Sub(started) >= streamHealthy {
			wait = streamBackoffFirst
		}
		d := wait
		if errors.Is(err, errDahuaAuth) {
			d = max(d, streamAuthWait)
		}
		if !s.sleep(ctx, d) {
			break
		}
		wait = min(wait*2, streamBackoffMax)
	}
	if c != nil {
		c.Close()
	}
}

// once opens the stream (falling back to [All] when the recorder refuses the code list) and
// reads it until it ends.
func (s *dahuaStream) once(ctx context.Context, c *Dahua) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	all := s.all
	s.mu.Unlock()
	res, err := c.attach(ctx, all)
	var se *dahuaStatusError
	if !all && errors.As(err, &se) && (se.Code == http.StatusBadRequest || se.Code >= 500) {
		s.mu.Lock()
		s.all = true
		s.mu.Unlock()
		res, err = c.attach(ctx, true)
	}
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	s.setConnected(true)
	// The read timeout: no byte (not even a heartbeat) for three heartbeats ends the stream.
	t := time.AfterFunc(s.readTimeout, cancel)
	defer t.Stop()
	r := bufio.NewReader(&touchReader{r: res.Body, touch: func() { t.Reset(s.readTimeout) }})
	return readMultipart(r, boundaryOf(res.Header.Get("Content-Type")), s.part)
}

type touchReader struct {
	r     io.Reader
	touch func()
}

func (t *touchReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 {
		t.touch()
	}
	return n, err
}

var dahuaWanted = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range dahuaCodes {
		m[c] = true
	}
	return m
}()

// part takes one part of the stream (a heartbeat has no Code and changes nothing).
func (s *dahuaStream) part(payload []byte) {
	evs := parseEvents(payload)
	if len(evs) == 0 {
		return
	}
	at := s.now().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range evs {
		if !dahuaWanted[e.code] {
			continue
		}
		ev := RecorderEvent{Code: e.code, Action: e.action, Index: e.index, At: at}
		if len(s.events) >= maxStreamEvents {
			s.events = append(s.events[:0], s.events[1:]...)
		}
		s.events = append(s.events, ev)
		key := e.code + "|" + strconv.Itoa(e.index)
		switch e.action {
		case "Start":
			if _, on := s.active[key]; !on {
				s.active[key] = ev
			}
		case "Stop":
			delete(s.active, key)
		}
	}
}

func (s *dahuaStream) setConnected(v bool) {
	s.mu.Lock()
	s.connected = v
	s.mu.Unlock()
}

// take returns the events since the last call, what is still on and whether the stream is
// connected.
func (s *dahuaStream) take() (events, active []RecorderEvent, connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	events, s.events = s.events, nil
	for _, e := range s.active {
		active = append(active, e)
	}
	sort.Slice(active, func(i, j int) bool {
		if active[i].Code != active[j].Code {
			return active[i].Code < active[j].Code
		}
		return active[i].Index < active[j].Index
	})
	return events, active, s.connected
}

// reconcile drops what the round shows is over though its Stop was missed (the stream was
// down): VideoLoss on a camera that is online, storage events when every disk is healthy.
func (s *dahuaStream) reconcile(cams []Camera, disks []RecorderDisk, disksRead bool) {
	online := map[int]bool{}
	for _, c := range cams {
		online[c.Channel] = c.Online
	}
	healthy := disksRead && len(disks) > 0
	for _, d := range disks {
		healthy = healthy && d.Healthy
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.active {
		switch {
		case e.Code == "VideoLoss" && online[e.Index]:
			delete(s.active, k)
		case (e.Code == "StorageNotExist" || e.Code == "StorageFailure") && healthy:
			delete(s.active, k)
		}
	}
}

// dahuaState is one recorder's memory between rounds: its client (the digest challenge is
// reused), what identifies it, the channel titles and its event stream.
type dahuaState struct {
	client   *Dahua
	sys      System
	titles   string
	noUptime bool
	stream   *dahuaStream
}

func newDahuaState() *dahuaState { return &dahuaState{} }

// close stops the stream and drops the connections.
func (st *dahuaState) close() {
	if st == nil {
		return
	}
	st.stream.stop()
	if st.client != nil {
		st.client.Close()
	}
}

// dahuaKey is what restarts a recorder's client and stream when it changes: the address,
// the credential (its password hashed) and whether it is paused.
func dahuaKey(d Device) string {
	c := d.Dahua
	if c == nil {
		return "none|" + strconv.FormatBool(d.Paused)
	}
	return strings.Join([]string{c.User, md5hex(c.Password), strconv.FormatBool(c.HTTPS), strconv.Itoa(c.Port), c.Pin, strconv.FormatBool(d.Paused)}, "|")
}

func dahuaStateOf(err error) string {
	switch {
	case errors.Is(err, ErrCertChanged):
		return StateCertChanged
	case errors.Is(err, errDahuaAuth):
		return StateAuthFailed
	case errors.Is(err, errDahuaPath):
		return StateError
	}
	var se *dahuaStatusError
	if errors.As(err, &se) {
		return StateError
	}
	return StateUnreachable
}

// pollDahua is one round for a Dahua recorder: who it is, its disks and cameras, and what
// its event stream saw since the last round.
func pollDahua(ctx context.Context, dial DahuaDialFunc, p *Profile, dev Device, st *dahuaState, now time.Time, inventory bool) (DeviceReport, []Sample) {
	rep := DeviceReport{ID: dev.ID, PolledAt: now.UnixMilli(), Profile: "dahua"}
	vendor, kind := "Dahua", "nvr"
	if p != nil {
		rep.Profile = p.Name
		if p.Vendor != "" {
			vendor = p.Vendor
		}
		if p.Kind != "" {
			kind = p.Kind
		}
	}
	fail := func(err error) (DeviceReport, []Sample) {
		rep.State, rep.Error = dahuaStateOf(err), err.Error()
		var cc *CertChangedError
		if errors.As(err, &cc) {
			rep.Fingerprint = cc.Seen
		}
		return rep, nil
	}
	if st.client == nil {
		c, err := dial(ctx, dev.Address, dev.Dahua)
		if err != nil {
			return fail(err)
		}
		st.client = c
	}
	c := st.client
	// The device type is read every round: it is how the recorder answers at all.
	body, err := c.Get(ctx, dahuaDeviceType)
	if err != nil {
		return fail(err)
	}
	rep.Fingerprint = c.Fingerprint()
	st.sys.Model = parseKV(body)["type"]
	if inventory || st.sys.Serial == "" {
		st.noUptime = false
		if b, err := c.Get(ctx, dahuaSerial); err == nil {
			st.sys.Serial = parseKV(b)["sn"]
		}
		if b, err := c.Get(ctx, dahuaVersion); err == nil {
			st.sys.Firmware, _, _ = strings.Cut(parseKV(b)["version"], ",")
		}
		if b, err := c.Get(ctx, dahuaMachineName); err == nil {
			st.sys.Name = parseKV(b)["name"]
		}
		if b, err := c.Get(ctx, dahuaChannelTitle); err == nil {
			st.titles = b
		}
		if b, err := c.Get(ctx, dahuaNetwork); err == nil {
			st.sys.MAC = parseMAC(b)
		}
	}
	sys := st.sys
	sys.Vendor, sys.Kind = vendor, kind
	if !st.noUptime {
		// UNCONFIRMED: no published source shows a CGI uptime call; one that isn't there
		// (non-200, "Error") is asked again only with the inventory.
		b, err := c.Get(ctx, dahuaUptime)
		if err != nil {
			st.noUptime = true
		} else {
			sys.UptimeS = parseUptime(b)
		}
	}

	rec := &Recorder{Disks: []RecorderDisk{}, Cameras: []Camera{}}
	disksRead, camsRead := false, false
	if b, err := c.Get(ctx, dahuaStorage); err == nil {
		rec.Disks, disksRead = parseDisks(b), true
	} else if dahuaStateOf(err) != StateError {
		return fail(err)
	}
	if b, err := c.Get(ctx, dahuaCameraState); err == nil {
		rec.Cameras, camsRead = parseCameras(b, st.titles), true
	} else if dahuaStateOf(err) != StateError {
		return fail(err)
	}
	if st.stream != nil {
		st.stream.reconcile(rec.Cameras, rec.Disks, disksRead)
		rec.Events, rec.Active, rec.Stream = st.stream.take()
	}

	lbl := []Label{{Name: "device", Value: dev.ID}}
	samples := []Sample{{Name: "watchlog_net_up", Labels: lbl, Value: 1}}
	if sys.UptimeS > 0 {
		samples = append(samples, Sample{Name: "watchlog_net_uptime_seconds", Labels: lbl, Value: float64(sys.UptimeS)})
	}
	if camsRead {
		online := 0
		for _, cam := range rec.Cameras {
			if cam.Online {
				online++
			}
		}
		samples = append(samples,
			Sample{Name: "watchlog_net_cameras_online", Labels: lbl, Value: float64(online)},
			Sample{Name: "watchlog_net_cameras_total", Labels: lbl, Value: float64(len(rec.Cameras))})
	}
	if disksRead && len(rec.Disks) > 0 {
		// The iSCSI disks are what is watched (the recordings' store); without one, all.
		anyISCSI := false
		for _, d := range rec.Disks {
			anyISCSI = anyISCSI || d.ISCSI
		}
		var used, total float64
		for _, d := range rec.Disks {
			if d.ISCSI || !anyISCSI {
				used += d.Used
				total += d.Total
			}
		}
		samples = append(samples,
			Sample{Name: "watchlog_net_recorder_used_bytes", Labels: lbl, Value: used},
			Sample{Name: "watchlog_net_recorder_total_bytes", Labels: lbl, Value: total})
	}
	rep.System, rep.Recorder, rep.State = &sys, rec, StateOK
	return rep, samples
}

// parseMAC reads the recorder's own MAC from getConfig&name=Network (INFERRED format:
// table.Network.DefaultInterface=eth0 and table.Network.eth0.PhysicalAddress=...), lower-cased.
func parseMAC(body string) string {
	kv := parseKV(body)
	iface := kv["table.Network.DefaultInterface"]
	if iface == "" {
		iface = "eth0"
	}
	return strings.ToLower(kv["table.Network."+iface+".PhysicalAddress"])
}

// parseUptime reads an uptime answer (UNCONFIRMED: a key with "uptime" in it, in seconds).
func parseUptime(body string) int64 {
	for k, v := range parseKV(body) {
		if strings.Contains(strings.ToLower(k), "uptime") {
			if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}
