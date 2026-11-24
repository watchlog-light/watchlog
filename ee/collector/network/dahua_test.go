// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// eventually waits (bounded) for a goroutine to get somewhere.
func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func serveNVR(t *testing.T, ctx context.Context, fake *netsim.Dahua, useTLS bool) Device {
	t.Helper()
	addr, err := fake.Serve(ctx, "127.0.0.1:0", useTLS)
	if err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(addr)
	p, _ := strconv.Atoi(port)
	return Device{ID: "dev-nvr-1", Name: "nvr-1", Address: host, Protocol: "dahua",
		Dahua: &DahuaCred{User: fake.User, Password: fake.Password, HTTPS: useTLS, Port: p}}
}

func TestDahuaDigest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := netsim.NVR()
	dev := serveNVR(t, ctx, fake, false)
	c, _ := DialDahua(ctx, dev.Address, dev.Dahua)
	for i := 0; i < 3; i++ {
		b, err := c.Get(ctx, dahuaDeviceType)
		if err != nil || parseKV(b)["type"] != fake.Model {
			t.Fatalf("getDeviceType: %q %v", b, err)
		}
	}
	// One 401, then the challenge is reused with nc counting up.
	if n := fake.Challenges.Load(); n != 1 {
		t.Fatalf("%d challenges, want 1", n)
	}
	if c.nc != 3 {
		t.Fatalf("nc %d", c.nc)
	}

	// A recorder that closes the connection and changes the nonce every time: a 401 and a
	// retry with the new challenge, each time.
	fake.OneTimeNonce = true // the nonce in hand works once more, then each Get is a 401 and a retry
	for i := 0; i < 3; i++ {
		if _, err := c.Get(ctx, dahuaSerial); err != nil {
			t.Fatal(err)
		}
	}
	if n := fake.Challenges.Load(); n != 3 {
		t.Fatalf("%d challenges, want 3", n)
	}

	// A wrong password: auth_failed.
	bad := dev
	cred := *dev.Dahua
	cred.Password = "wrong"
	bad.Dahua = &cred
	if _, err := DialDahua(ctx, "x", nil); err == nil {
		t.Fatal("no credential accepted")
	}
	rep, samples := pollDahua(ctx, DialDahua, nil, bad, newDahuaState(), time.Now(), true)
	if rep.State != StateAuthFailed || samples != nil {
		t.Fatalf("wrong password: %s %s", rep.State, rep.Error)
	}
	// Unreachable.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	gone := ln.Addr().String()
	_ = ln.Close()
	rep, _ = pollDahua(ctx, DialDahua, nil, Device{ID: "x", Address: gone, Dahua: &cred}, newDahuaState(), time.Now(), true)
	if rep.State != StateUnreachable {
		t.Fatalf("closed port: %s", rep.State)
	}
}

func TestDahuaChallengeParse(t *testing.T) {
	ch := parseChallenge([]string{`Basic realm="x"`, `Digest realm="Login to 8L0, ok", qop="auth,auth-int", nonce="n1", opaque="o"`})
	if ch == nil || ch.realm != "Login to 8L0, ok" || ch.nonce != "n1" || ch.opaque != "o" || !ch.qopAuth {
		t.Fatalf("%+v", ch)
	}
	if parseChallenge([]string{`Basic realm="x"`}) != nil {
		t.Fatal("basic taken for digest")
	}
}

func TestDahuaDisks(t *testing.T) {
	body := strings.Join([]string{
		"list.info[0].Detail[0].IsError=false",
		"list.info[0].Detail[0].Path=/dev/sda1",
		"list.info[0].Detail[0].TotalBytes=1000000000000.000000",
		"list.info[0].Detail[0].UsedBytes=400000000000.000000",
		"list.info[0].Detail[1].IsError=false",
		"list.info[0].Detail[1].TotalBytes=495797858304.000000",
		"list.info[0].Detail[1].UsedBytes=100000000000.000000",
		"list.info[0].Name=/dev/sda",
		"list.info[0].State=Success",
		"list.info[1].Detail[0].IsError=true",
		"list.info[1].Detail[0].Path=/dev/iscsi0p1",
		"list.info[1].Detail[0].TotalBytes=0.000000",
		"list.info[1].Detail[0].UsedBytes=0.000000",
		"list.info[1].Name=/dev/iscsi0",
		"list.info[1].State=Error",
		"list.info[2].Detail[0].IsError=true",
		"list.info[2].Detail[0].TotalBytes=10.0",
		"list.info[2].Name=/dev/sdb",
		"list.info[2].State=Success",
	}, "\r\n")
	d := parseDisks(body)
	if len(d) != 3 {
		t.Fatalf("%+v", d)
	}
	if d[0].Name != "/dev/sda" || d[0].ISCSI || !d[0].Healthy || d[0].Total != 1495797858304 || d[0].Used != 500000000000 {
		t.Fatalf("local %+v", d[0])
	}
	if !d[1].ISCSI || d[1].Healthy || d[1].State != "Error" {
		t.Fatalf("iscsi %+v", d[1])
	}
	if d[2].Healthy { // Success but a part in error
		t.Fatalf("sdb %+v", d[2])
	}
	for _, c := range []struct {
		f    map[string]string
		want bool
	}{
		{map[string]string{"Name": "/dev/sda"}, false},
		{map[string]string{"Name": "/dev/sda", "Detail[0].Type": "ReadWrite"}, false},
		{map[string]string{"Name": "/dev/net0", "Detail[0].Path": "/mnt/iSCSI/1"}, true},
		{map[string]string{"Name": "/dev/net0", "IsNet": "true"}, true},
		{map[string]string{"Name": "/dev/net0", "Type": "Net"}, true},
		{map[string]string{"Name": "/dev/sdc", "IsNet": "true"}, false},
		{map[string]string{"Name": "/dev/nfs0"}, false},
	} {
		if got := isISCSI(c.f); got != c.want {
			t.Errorf("isISCSI(%v) = %v", c.f, got)
		}
	}
}

func TestDahuaCameras(t *testing.T) {
	cams := parseCameras(
		"states[0].channel=0\r\nstates[0].connectionState=Connected\r\nstates[1].channel=5\r\nstates[1].connectionState=Disconnected\r\n",
		"table.ChannelTitle[0].Name=cam-1\r\ntable.ChannelTitle[5].Name=cam-6\r\n")
	if len(cams) != 2 || cams[0] != (Camera{Channel: 0, Name: "cam-1", Online: true}) || cams[1] != (Camera{Channel: 5, Name: "cam-6", Online: false}) {
		t.Fatalf("%+v", cams)
	}
	cams = parseCameras("status.states[0].channel=2\nstatus.states[0].connectionState=Connected\n", "")
	if len(cams) != 1 || cams[0].Channel != 2 || !cams[0].Online {
		t.Fatalf("status prefix %+v", cams)
	}
	if parseMAC("table.Network.DefaultInterface=eth1\r\ntable.Network.eth0.PhysicalAddress=AA:00:00:00:00:01\r\ntable.Network.eth1.PhysicalAddress=AA:00:00:00:00:02\r\n") != "aa:00:00:00:00:02" {
		t.Fatal("mac of the default interface")
	}
}

func TestDahuaMultipart(t *testing.T) {
	collect := func(stream, boundary string) ([]string, error) {
		var parts []string
		err := readMultipart(bufio.NewReader(strings.NewReader(stream)), boundary, func(b []byte) { parts = append(parts, string(b)) })
		return parts, err
	}
	withLen := func(p string) string {
		return "--myboundary\r\nContent-Type: text/plain\r\nContent-Length: " + strconv.Itoa(len(p)) + "\r\n\r\n" + p + "\r\n"
	}
	// With Content-Length (a payload with a blank line and a data JSON in it).
	ev := "Code=VideoLoss;action=Start;index=3;data={\r\n\r\n  \"a\" : \"x;y\"\r\n}\r\n"
	parts, err := collect(withLen("Heartbeat")+withLen(ev)+"--myboundary--\r\n", "myboundary")
	if !errors.Is(err, errStreamEnd) || len(parts) != 2 || parts[1] != ev {
		t.Fatalf("%q %v", parts, err)
	}
	// Without Content-Length, a boundary of its own.
	parts, err = collect("\r\n--b0\r\nContent-Type: text/plain\r\n\r\nCode=NetAbort;action=Pulse;index=0\r\n--b0\r\n\r\nHeartbeat\r\n--b0--\r\n", "b0")
	if !errors.Is(err, errStreamEnd) || len(parts) != 2 || strings.TrimSpace(parts[0]) != "Code=NetAbort;action=Pulse;index=0" {
		t.Fatalf("%q %v", parts, err)
	}
	// Cut short: an error, never a hang.
	if _, err := collect(withLen("Heartbeat")[:40], "myboundary"); err == nil {
		t.Fatal("a cut stream ended cleanly")
	}
	if boundaryOf("multipart/x-mixed-replace; boundary=abc") != "abc" || boundaryOf("text/plain") != "myboundary" {
		t.Fatal("boundary")
	}

	evs := parseEvents([]byte(ev))
	if len(evs) != 1 || evs[0] != (dahuaEvent{code: "VideoLoss", action: "Start", index: 3}) {
		t.Fatalf("%+v", evs)
	}
	if parseEvents([]byte("Heartbeat\r\n")) != nil {
		t.Fatal("heartbeat read as an event")
	}

	// The active set: Start without Stop; Pulse is an event only; other codes are dropped.
	now := time.UnixMilli(1_000_000)
	s := newDahuaStream(func() time.Time { return now })
	for _, p := range []string{
		"Code=VideoLoss;action=Start;index=3", "Code=VideoLoss;action=Start;index=4",
		"Code=VideoLoss;action=Start;index=3", "Code=NetAbort;action=Pulse;index=0",
		"Code=VideoMotion;action=Start;index=1", "Code=VideoLoss;action=Stop;index=4",
		"Code=StorageNotExist;action=Start;index=1",
	} {
		s.part([]byte(p))
	}
	events, active, _ := s.take()
	if len(events) != 6 || events[0].At != 1_000_000 {
		t.Fatalf("events %+v", events)
	}
	if len(active) != 2 || active[0].Code != "StorageNotExist" || active[1] != (RecorderEvent{Code: "VideoLoss", Action: "Start", Index: 3, At: 1_000_000}) {
		t.Fatalf("active %+v", active)
	}
	if events, active, _ = s.take(); len(events) != 0 || len(active) != 2 {
		t.Fatal("take didn't reset the events, or dropped the active set")
	}
	// Bounded.
	for i := 0; i < maxStreamEvents+10; i++ {
		s.part([]byte("Code=NetAbort;action=Pulse;index=" + strconv.Itoa(i)))
	}
	if events, _, _ = s.take(); len(events) != maxStreamEvents || events[0].Index != 10 {
		t.Fatalf("%d events, first %d", len(events), events[0].Index)
	}
	// A round that shows camera 3 online and every disk healthy ends what was missed.
	s.reconcile([]Camera{{Channel: 3, Online: true}}, []RecorderDisk{{Healthy: true}}, true)
	if _, active, _ = s.take(); len(active) != 0 {
		t.Fatalf("reconcile left %+v", active)
	}
}

func TestDahuaStreamReconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := netsim.NVR()
	fake.RefuseCodeList = true
	fake.HeartbeatEvery = 20 * time.Millisecond
	dev := serveNVR(t, ctx, fake, false)

	var mu sync.Mutex
	now := time.Unix(1_800_000_000, 0)
	var waits []time.Duration
	s := newDahuaStream(func() time.Time { mu.Lock(); defer mu.Unlock(); return now })
	s.sleep = func(ctx context.Context, d time.Duration) bool {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
		return ctx.Err() == nil
	}
	s.start(DialDahua, dev)
	defer s.stop()

	// The code list is refused (400): [All] at once, and the codes are filtered here.
	eventually(t, "the stream", func() bool { return fake.Streams() == 1 })
	if a := fake.Attaches.Load(); a != 2 {
		t.Fatalf("%d attaches, want 2 (list refused, then [All])", a)
	}
	fake.Emit("VideoMotion", "Start", 1)
	fake.SetCamera(7, false)
	eventually(t, "VideoLoss", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.events) > 0 })
	events, active, connected := s.take()
	if !connected || len(events) != 1 || events[0].Code != "VideoLoss" || len(active) != 1 || active[0].Index != 7 {
		t.Fatalf("connected %v events %+v active %+v", connected, events, active)
	}

	// The recorder ends the stream three times at once: 1 s, 2 s, 4 s.
	for i := 0; i < 3; i++ {
		fake.DropStreams()
		eventually(t, "the reconnect", func() bool { return fake.Streams() == 1 && fake.Attaches.Load() == int64(3+i) })
	}
	// A stream that lived 60 s starts over at 1 s.
	mu.Lock()
	now = now.Add(61 * time.Second)
	mu.Unlock()
	fake.DropStreams()
	eventually(t, "the reconnect", func() bool { return fake.Streams() == 1 && fake.Attaches.Load() == 6 })
	mu.Lock()
	got := append([]time.Duration(nil), waits...)
	mu.Unlock()
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, time.Second}
	if len(got) != len(want) {
		t.Fatalf("waits %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("waits %v, want %v", got, want)
		}
	}
	// Heartbeats keep it up and add nothing.
	time.Sleep(60 * time.Millisecond)
	if events, _, connected := s.take(); !connected || len(events) != 0 {
		t.Fatalf("after heartbeats: %v %+v", connected, events)
	}
	s.stop()
	eventually(t, "the stream to close", func() bool { return fake.Streams() == 0 })
	if _, _, connected := s.take(); connected {
		t.Fatal("still connected after stop")
	}
	if fake.Writes.Load() != 0 {
		t.Fatalf("%d writes", fake.Writes.Load())
	}
}

func TestDahuaCertPin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := netsim.NVR()
	pin, err := fake.NewCert()
	if err != nil {
		t.Fatal(err)
	}
	dev := serveNVR(t, ctx, fake, true)
	// First contact: the fingerprint is reported to be pinned.
	rep, _ := pollDahua(ctx, DialDahua, nil, dev, newDahuaState(), time.Now(), true)
	if rep.State != StateOK || rep.Fingerprint != pin {
		t.Fatalf("first contact: %s %s %q", rep.State, rep.Error, rep.Fingerprint)
	}
	dev.Dahua.Pin = pin
	if rep, _ = pollDahua(ctx, DialDahua, nil, dev, newDahuaState(), time.Now(), true); rep.State != StateOK {
		t.Fatalf("pinned: %s %s", rep.State, rep.Error)
	}
	// A new certificate: cert_changed with the one seen, for an Owner to accept.
	newPin, _ := fake.NewCert()
	rep, _ = pollDahua(ctx, DialDahua, nil, dev, newDahuaState(), time.Now(), true)
	if rep.State != StateCertChanged || rep.Fingerprint != newPin {
		t.Fatalf("changed: %s %q", rep.State, rep.Fingerprint)
	}
}

func TestDahuaOnlyReads(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := netsim.NVR()
	dev := serveNVR(t, ctx, fake, false)
	c, _ := DialDahua(ctx, dev.Address, dev.Dahua)
	for _, p := range []string{
		"/cgi-bin/configManager.cgi?action=setConfig&ChannelTitle[0].Name=x",
		"/cgi-bin/magicBox.cgi?action=reboot",
		"/cgi-bin/magicBox.cgi?action=getDeviceType&x=1",
		dahuaAttachAll, // the stream, not a Get
	} {
		if _, err := c.Get(ctx, p); !errors.Is(err, errDahuaPath) {
			t.Errorf("%s: %v", p, err)
		}
	}
	if n := fake.Writes.Load(); n != 0 {
		t.Fatalf("%d writes reached the recorder", n)
	}
	// The fake counts what isn't a read (so the check above means something).
	res, err := http.Post("http://"+net.JoinHostPort(dev.Address, strconv.Itoa(dev.Dahua.Port))+"/cgi-bin/magicBox.cgi?action=reboot", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNotFound || fake.Writes.Load() != 1 {
		t.Fatalf("POST: %d, writes %d", res.StatusCode, fake.Writes.Load())
	}
}

func TestDahuaPollerRound(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := netsim.NVR()
	fake.HeartbeatEvery = 50 * time.Millisecond
	dev := serveNVR(t, ctx, fake, false)
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	p, err := NewPoller(nil, Dial, DialROS)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	p.SetDahua(DialDahua, func() time.Time { return now })
	p.Configure(configOf(t, Config{Devices: []Device{dev}}))
	eventually(t, "the stream", func() bool { return fake.Streams() == 1 })

	fake.SetCamera(2, false)
	fake.SetISCSI(false)
	st := p.states[dev.ID].dahua
	eventually(t, "the events", func() bool {
		st.stream.mu.Lock()
		defer st.stream.mu.Unlock()
		return len(st.stream.events) == 2
	})
	rep, samples := p.Round(ctx, now)
	if rep == nil || len(rep.Devices) != 1 {
		t.Fatalf("%+v", rep)
	}
	d := rep.Devices[0]
	if d.State != StateOK || d.Profile != "dahua" {
		t.Fatalf("%s %s", d.State, d.Error)
	}
	s := d.System
	if s.Name != "nvr-1" || s.Model != fake.Model || s.Serial != fake.Serial || s.Firmware != "4.001.0000000.3.R" ||
		s.Vendor != "Dahua" || s.Kind != "nvr" || s.UptimeS != 0 || s.MAC != netsim.NVRMAC {
		t.Fatalf("system %+v", s)
	}
	r := d.Recorder
	if !r.Stream || len(r.Cameras) != 16 || r.Cameras[2].Online || r.Cameras[2].Name != "cam-3" || !r.Cameras[3].Online {
		t.Fatalf("recorder %+v", r)
	}
	if len(r.Disks) != 2 || r.Disks[0].ISCSI || !r.Disks[0].Healthy || !r.Disks[1].ISCSI || r.Disks[1].Healthy || r.Disks[1].State != "Error" {
		t.Fatalf("disks %+v", r.Disks)
	}
	if len(r.Events) != 2 || len(r.Active) != 2 || r.Active[0].Code != "StorageNotExist" || r.Active[1] != (RecorderEvent{Code: "VideoLoss", Action: "Start", Index: 2, At: now.UnixMilli()}) {
		t.Fatalf("events %+v active %+v", r.Events, r.Active)
	}
	want := map[string]float64{
		"watchlog_net_up": 1, "watchlog_net_cameras_online": 15, "watchlog_net_cameras_total": 16,
		"watchlog_net_recorder_used_bytes": 0, "watchlog_net_recorder_total_bytes": 0, // the iSCSI disk is lost
	}
	if len(samples) != len(want) {
		t.Fatalf("samples %+v", samples)
	}
	for _, sm := range samples {
		if v, ok := want[sm.Name]; !ok || v != sm.Value || len(sm.Labels) != 1 || sm.Labels[0] != (Label{Name: "device", Value: dev.ID}) {
			t.Fatalf("sample %+v", sm)
		}
	}

	// Back: the camera and the disk; the next round has the Stops and nothing active.
	fake.SetCamera(2, true)
	fake.SetISCSI(true)
	eventually(t, "the stops", func() bool {
		st.stream.mu.Lock()
		defer st.stream.mu.Unlock()
		return len(st.stream.events) == 2
	})
	now = now.Add(Round)
	rep, samples = p.Round(ctx, now)
	r = rep.Devices[0].Recorder
	if len(r.Events) != 2 || len(r.Active) != 0 || !r.Disks[1].Healthy {
		t.Fatalf("after: %+v", r)
	}
	for _, sm := range samples {
		if sm.Name == "watchlog_net_recorder_total_bytes" && sm.Value != 15_990_000_000_000 {
			t.Fatalf("total %v: the iSCSI disk only", sm.Value)
		}
	}

	// A changed password restarts the stream; a removed device stops it.
	dev2 := dev
	c2 := *dev.Dahua
	c2.Password = "changed"
	dev2.Dahua = &c2
	p.Configure(configOf(t, Config{Devices: []Device{dev2}}))
	if p.states[dev.ID].dahua == st {
		t.Fatal("the recorder's state survived a new credential")
	}
	p.Configure(configOf(t, Config{}))
	eventually(t, "the streams to close", func() bool { return fake.Streams() == 0 })
	if fake.Writes.Load() != 0 {
		t.Fatalf("%d writes", fake.Writes.Load())
	}
}
