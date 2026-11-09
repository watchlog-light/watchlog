// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const pw = "wl_mon_0123456789abcdefghijklmnop"

// authCheck is an integration that logs in and checks privileges: the password must be
// pw, and the user "readonly" lacks pg_monitor.
type authCheck struct{}

func (authCheck) Scrape(_ context.Context, _ Target, _ bool) Result {
	return Result{State: StateOK}
}

func (authCheck) Probe(_ context.Context, t Target) ProbeResult {
	switch {
	case t.Auth == nil || t.Auth.Password != pw:
		return ProbeResult{Code: ProbeAuthFailed, Error: `password authentication failed for user "watchlog"`}
	case t.Auth.Username == "readonly":
		return ProbeResult{Code: ProbePermission, Missing: []string{"pg_monitor"}}
	}
	return ProbeResult{Code: ProbeOK, Version: "16.4", Facts: map[string]any{"databases": 3},
		Excess: []string{"superuser"}}
}

func TestPasswordFromAFileUnderTheSecretsDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "billing-postgres"), []byte(pw+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := &Credentials{Dir: dir}
	auth, err := c.Resolve(context.Background(), &Credential{Username: "watchlog", File: "billing-postgres"})
	if err != nil || auth.Username != "watchlog" || auth.Password != pw {
		t.Fatalf("Resolve = %+v, %v", auth, err)
	}
	for _, bad := range []string{"../etc/passwd", "a/b", ".hidden", "", "x y"} {
		if _, err := c.Resolve(context.Background(), &Credential{File: bad}); err == nil ||
			!strings.Contains(err.Error(), "plain name") {
			if bad != "" {
				t.Errorf("file %q: err = %v, want a refusal", bad, err)
			}
		}
	}
	_, err = c.Resolve(context.Background(), &Credential{File: "missing"})
	if err == nil || !strings.Contains(err.Error(), "/etc/watchlog/secrets/missing doesn't exist") {
		t.Errorf("missing file err = %v", err)
	}
}

// apiServer fakes GET /api/v1/namespaces/{ns}/secrets/{name} with the token check.
func apiServer(t *testing.T, token string) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/namespaces/watchlog/secrets/billing-db":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{
				"password": base64.StdEncoding.EncodeToString([]byte(pw)),
			}})
		case "/api/v1/namespaces/watchlog/secrets/other":
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestPasswordFromAKubernetesSecret(t *testing.T) {
	srv := apiServer(t, "sa-token")
	defer srv.Close()
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	k := &KubeSecrets{Base: srv.URL, Client: srv.Client(), TokenPath: tokenPath}
	c := &Credentials{Secrets: k}
	ref := func(name, key string) *Credential {
		return &Credential{Username: "watchlog", Secret: &SecretRef{Namespace: "watchlog", Name: name, Key: key}}
	}
	auth, err := c.Resolve(context.Background(), ref("billing-db", "password"))
	if err != nil || auth.Password != pw {
		t.Fatalf("Resolve = %+v, %v", auth, err)
	}
	cases := map[string]string{
		"other":   "may not read the Secret watchlog/other",
		"missing": "the Secret watchlog/missing doesn't exist",
	}
	for name, want := range cases {
		if _, err := c.Resolve(context.Background(), ref(name, "password")); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v, want %q", name, err, want)
		}
	}
	if _, err := c.Resolve(context.Background(), ref("billing-db", "nope")); err == nil ||
		!strings.Contains(err.Error(), `has no key "nope"`) {
		t.Errorf("missing key err = %v", err)
	}
	// Outside a cluster there is no reader.
	if _, err := (&Credentials{}).Resolve(context.Background(), ref("billing-db", "password")); err == nil {
		t.Error("a Secret was resolved without a reader")
	}
}

func TestCredentialsNeverReachLogs(t *testing.T) {
	cred := Credential{Username: "watchlog", Password: pw}
	auth := Auth{Username: "watchlog", Password: pw}
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	log.Info("x", "cred", cred, "auth", auth, "ptr", &cred)
	text := fmt.Sprintf("%v %+v %s %v", cred, auth, cred, &auth)
	for _, out := range []string{logs.String(), text} {
		if strings.Contains(out, pw) {
			t.Errorf("password in %q", out)
		}
	}
}

func TestProbesTryTheAccessAndPostWhatTheyFound(t *testing.T) {
	var mu sync.Mutex
	var posted []ProbeResults
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ingest/v1/integrations/probes" {
			var p ProbeResults
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &p)
			mu.Lock()
			posted = append(posted, p)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	ln := listen(t)
	c := newCollector(t, srv.URL, Registry{"postgres": authCheck{}})
	c.ProbesURL = srv.URL + "/ingest/v1/integrations/probes"
	c.Credentials = &Credentials{Dir: t.TempDir()}
	members := []Member{{Name: "pg-0", Address: ln}}
	down := []Member{{Name: "pg-1", Address: "127.0.0.1:1"}}
	cred := func(user, pass string) *Credential { return &Credential{Username: user, Password: pass} }
	results := c.RunProbes(context.Background(), []Probe{
		{ID: "good", Type: "postgres", Members: members, Credential: cred("watchlog", pw)},
		{ID: "wrong", Type: "postgres", Members: members, Credential: cred("watchlog", "nope")},
		{ID: "weak", Type: "postgres", Members: members, Credential: cred("readonly", pw)},
		{ID: "file", Type: "postgres", Members: members, Credential: &Credential{File: "missing"}},
		// No integration logs in to rabbitmq here: the port answering isn't a pass.
		{ID: "untested", Type: "rabbitmq", Members: members, Credential: cred("guest", "guest")},
		{ID: "open", Type: "rabbitmq", Members: members},
		{ID: "down", Type: "rabbitmq", Members: down},
	})
	got := map[string]ProbeResult{}
	for _, r := range results {
		got[r.ID] = r
	}
	want := map[string]struct {
		ok   bool
		code string
	}{
		"good": {true, ProbeOK}, "wrong": {false, ProbeAuthFailed}, "weak": {false, ProbePermission},
		"file": {false, ProbeCredential}, "untested": {false, ProbeLoginUntested},
		"open": {true, ProbeOK}, "down": {false, ProbeUnreachable},
	}
	for id, w := range want {
		if g := got[id]; g.OK != w.ok || g.Code != w.code {
			t.Errorf("%s = ok %v code %q (%s), want ok %v code %q", id, g.OK, g.Code, g.Error, w.ok, w.code)
		}
	}
	if g := got["good"]; g.Version != "16.4" || g.Facts["databases"] != 3 || len(g.Excess) != 1 {
		t.Errorf("good = %+v", g)
	}
	if g := got["weak"]; len(g.Missing) != 1 || g.Missing[0] != "pg_monitor" {
		t.Errorf("weak = %+v", g)
	}
	if g := got["file"]; !strings.Contains(g.Error, "/etc/watchlog/secrets/missing") {
		t.Errorf("file = %+v", g)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 1 || posted[0].Host != "docker-01" || len(posted[0].Results) != len(want) {
		t.Fatalf("posted = %+v", posted)
	}
	raw, _ := json.Marshal(posted)
	if strings.Contains(string(raw), pw) {
		t.Error("a password was posted back")
	}
}

func TestANewOrRequestedProbeWakesTheLoop(t *testing.T) {
	c := &Collector{probeWake: make(chan struct{}, 1)}
	woke := func() bool {
		select {
		case <-c.probeWake:
			return true
		default:
			return false
		}
	}
	c.SetConfig(&Config{Probes: []Probe{{ID: "a", Requested: "1"}}})
	if !woke() {
		t.Error("a new probe didn't wake the loop")
	}
	c.SetConfig(&Config{Probes: []Probe{{ID: "a", Requested: "1"}}})
	if woke() {
		t.Error("an unchanged probe woke the loop")
	}
	c.SetConfig(&Config{Probes: []Probe{{ID: "a", Requested: "2"}}})
	if !woke() {
		t.Error("Check now didn't wake the loop")
	}
}

// listen opens a TCP listener that accepts and closes, for the TCP check.
func listen(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return ln.Addr().String()
}
