// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

// v3Agent serves one simulated device answering the users given, on its own port.
func v3Agent(t *testing.T, users []netsim.V3User) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	a := netsim.Build(netsim.Spec{Name: "sw-v3", Model: "Generic"}, start)
	a.Users = users
	srv := &netsim.Server{Community: "public", Clock: func() time.Time { return start.Add(time.Hour) }}
	addr, err := srv.Listen(ctx, "127.0.0.1:0", a)
	if err != nil {
		t.Fatal(err)
	}
	return addr
}

var (
	authNames = map[gosnmp.SnmpV3AuthProtocol]string{
		gosnmp.MD5: "MD5", gosnmp.SHA: "SHA", gosnmp.SHA224: "SHA224", gosnmp.SHA256: "SHA256",
		gosnmp.SHA384: "SHA384", gosnmp.SHA512: "SHA512",
	}
	privNames = map[gosnmp.SnmpV3PrivProtocol]string{
		gosnmp.NoPriv: "NONE", gosnmp.DES: "DES", gosnmp.AES: "AES", gosnmp.AES192: "AES192",
		gosnmp.AES256: "AES256", gosnmp.AES192C: "AES192C", gosnmp.AES256C: "AES256C",
	}
)

// sysName reads one value with a profile, as a poll's first request does.
func sysName(t *testing.T, addr string, c *SNMPCred) (string, error) {
	t.Helper()
	r, err := fastDial(addr, c, "", "")
	if err != nil {
		return "", err
	}
	defer func() { _ = r.Close() }()
	r.(*session).g.Timeout = 300 * time.Millisecond
	vs, err := r.Get(context.Background(), []string{"1.3.6.1.2.1.1.5.0"})
	if err != nil {
		return "", err
	}
	if len(vs) == 0 {
		return "", nil
	}
	s, _ := vs[0].Value.([]byte)
	return string(s), nil
}

// Every authentication (MD5, SHA, SHA-2) with every privacy (none, DES, AES and its key
// lengths, Cisco's key extension) the collector and the simulator both speak, and the three
// security levels (1.0.4).
func TestSNMPv3EveryCombination(t *testing.T) {
	n := 0
	for auth, an := range authNames {
		for priv, pn := range privNames {
			n++
			user := netsim.V3User{Name: "watchlog", Auth: auth, AuthPass: "auth-pass-1", Priv: priv, PrivPass: "priv-pass-1"}
			addr := v3Agent(t, []netsim.V3User{user})
			name, err := sysName(t, addr, &SNMPCred{Version: "3", User: "watchlog", AuthProto: an, AuthKey: "auth-pass-1", PrivProto: pn, PrivKey: "priv-pass-1"})
			if err != nil || name != "sw-v3" {
				t.Errorf("%s/%s: %q, %v", an, pn, name, err)
			}
		}
	}
	// noAuthNoPriv: a user without authentication, read with NONE.
	addr := v3Agent(t, []netsim.V3User{{Name: "public-ro"}})
	if name, err := sysName(t, addr, &SNMPCred{Version: "3", User: "public-ro", AuthProto: "NONE", PrivProto: "NONE"}); err != nil || name != "sw-v3" {
		t.Errorf("noAuthNoPriv: %q, %v", name, err)
	}
	// NONE for authentication means no privacy either, whatever the profile says.
	if name, err := sysName(t, addr, &SNMPCred{Version: "3", User: "public-ro", AuthProto: "NONE", PrivProto: "AES", PrivKey: "ignored-1"}); err != nil || name != "sw-v3" {
		t.Errorf("noAuthNoPriv with a privacy left over: %q, %v", name, err)
	}
	if n != 42 {
		t.Fatalf("combinations: %d", n)
	}
}

// What a device says when one value is wrong: SNMPv3's reports name the user and the digest;
// a privacy that doesn't match ends in silence after the engine was discovered (a QNAP).
func TestSNMPv3Mismatches(t *testing.T) {
	qnap := v3Agent(t, netsim.QNAPUsers("watchlog", "auth-pass-1", "priv-pass-1"))
	ok := SNMPCred{Version: "3", User: "watchlog", AuthProto: "SHA", AuthKey: "auth-pass-1", PrivProto: "DES", PrivKey: "priv-pass-1"}
	if name, err := sysName(t, qnap, &ok); err != nil || name != "sw-v3" {
		t.Fatalf("SHA with DES on the QNAP: %q, %v", name, err)
	}
	for _, c := range []struct {
		what string
		edit func(*SNMPCred)
		want error
	}{
		{"another user", func(c *SNMPCred) { c.User = "nobody" }, errSNMPUser},
		{"a wrong authentication password", func(c *SNMPCred) { c.AuthKey = "auth-pass-2" }, errSNMPDigest},
		{"MD5 where the device has SHA", func(c *SNMPCred) { c.AuthProto = "MD5" }, errSNMPDigest},
		{"no privacy where the device wants it", func(c *SNMPCred) { c.PrivProto = "NONE" }, errSNMPLevel},
	} {
		cred := ok
		c.edit(&cred)
		_, err := sysName(t, qnap, &cred)
		if !errorsIs(err, c.want) {
			t.Errorf("%s: %v, want %v", c.what, err, c.want)
		}
	}
	// AES where QTS encrypts with DES, or a wrong privacy password: the NAS can't parse what it
	// decrypts and stays silent, after answering the engine discovery.
	for what, edit := range map[string]func(*SNMPCred){
		"AES where the NAS has DES": func(c *SNMPCred) { c.PrivProto = "AES" },
		"a wrong privacy password":  func(c *SNMPCred) { c.PrivKey = "priv-pass-2" },
		"AES-256 where it has DES":  func(c *SNMPCred) { c.PrivProto = "AES256" },
	} {
		cred := ok
		edit(&cred)
		// AES's ciphertext is rarely a whole number of DES blocks: the NAS reports a decryption
		// error then; a DES with the wrong key decrypts to noise and the NAS is silent.
		if _, err := sysName(t, qnap, &cred); !errorsIs(err, errSNMPSilent) && !errorsIs(err, errSNMPPrivacy) {
			t.Errorf("%s: %v", what, err)
		}
	}
	// The wrong DES key alone: silence after the discovery, said as a privacy mismatch.
	wrong := ok
	wrong.PrivKey = "priv-pass-2"
	if _, err := sysName(t, qnap, &wrong); !errorsIs(err, errSNMPSilent) {
		t.Errorf("a wrong DES key: %v", err)
	}
	// Nothing listening: not even the discovery is answered.
	gone, _ := net.ListenPacket("udp", "127.0.0.1:0")
	_, gp, _ := net.SplitHostPort(gone.LocalAddr().String())
	_ = gone.Close()
	gpn, _ := strconv.Atoi(gp)
	if _, err := sysName(t, "127.0.0.1:"+strconv.Itoa(gpn), &ok); !errorsIs(err, errNoAnswer) {
		t.Errorf("an address nothing answers on: %v", err)
	}
}

func errorsIs(err, target error) bool {
	for e := err; e != nil; {
		if e == target {
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}

// "Find what works" (1.0.4): the combinations in order, one try each, narrowed by what the
// device reports, until one answers; never another user or password.
func TestFindWhatWorks(t *testing.T) {
	old := probeEvery
	probeEvery = time.Millisecond
	defer func() { probeEvery = old }()
	ctx := context.Background()
	qnap := v3Agent(t, netsim.QNAPUsers("watchlog", "auth-pass-1", "priv-pass-1"))
	cand := func(user, auth, priv string) Candidate {
		return Candidate{ID: auth + ":" + priv, Protocol: "snmp", SNMP: &SNMPCred{Version: "3", User: user, AuthProto: auth, AuthKey: "auth-pass-1", PrivProto: priv, PrivKey: "priv-pass-1"}}
	}
	order := func(user string) []Candidate {
		var out []Candidate
		for _, a := range []string{"SHA256", "SHA", "MD5", "SHA512"} {
			for _, p := range []string{"AES", "AES256", "DES"} {
				out = append(out, cand(user, a, p))
			}
		}
		return out
	}
	p, _ := NewPoller(nil, fastDial, DialROS)
	d := Discovery{ID: "find-1", Seeds: []string{qnap}, Find: true, Credentials: order("watchlog")}
	f, _ := p.probe(ctx, qnap, d, false)
	if !f.Answered || f.Credential != "SHA:DES" || f.Name != "sw-v3" {
		t.Fatalf("found %+v", f)
	}
	// SHA-256 is ruled out by its first wrong digest; with SHA the privacy fails (AES, AES-256)
	// before DES answers: four tries of the twelve.
	if strings.Join(f.Tried, ",") != "SHA256:AES,SHA:AES,SHA:AES256,SHA:DES" {
		t.Errorf("tried %v", f.Tried)
	}
	// An unknown user ends the search at once: no other user is ever tried.
	d.Credentials = order("nobody")
	f, _ = p.probe(ctx, qnap, d, false)
	if f.Answered || len(f.Tried) != 1 || !strings.Contains(f.Error, "doesn't know this SNMPv3 user") {
		t.Errorf("an unknown user: %+v", f)
	}
	// Wrong passwords: no combination answers, and none is tried twice.
	bad := order("watchlog")
	for i := range bad {
		bad[i].SNMP.AuthKey = "auth-pass-9"
	}
	d.Credentials = bad
	f, _ = p.probe(ctx, qnap, d, false)
	if f.Answered || len(f.Tried) != 4 || !strings.Contains(f.Error, "authentication password or protocol") {
		t.Errorf("a wrong authentication password: %+v", f)
	}
	// Nothing at the address: one try, then the search ends.
	gone, _ := net.ListenPacket("udp", "127.0.0.1:0")
	addr := gone.LocalAddr().String()
	_ = gone.Close()
	d.Credentials = order("watchlog")
	f, _ = p.probe(ctx, addr, d, false)
	if f.Answered || len(f.Tried) != 1 {
		t.Errorf("no answer: %+v", f)
	}
}
