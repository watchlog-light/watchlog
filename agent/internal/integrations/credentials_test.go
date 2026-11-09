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

// authCheck is an integration that records the password it was given.
type authCheck struct {
	mu   sync.Mutex
	seen []string
}

func (a *authCheck) Scrape(_ context.Context, t Target, _ bool) Result {
	a.mu.Lock()
	defer a.mu.Unlock()
	if t.Auth == nil {
		a.seen = append(a.seen, "")
		return Result{State: StateError, Error: "authentication required"}
	}
	a.seen = append(a.seen, t.Auth.Password)
	if t.Auth.Password != pw {
		return Result{State: StateError, Error: "wrong password"}
	}
	return Result{State: StateOK, ServiceVersion: "16.4", Facts: map[string]any{"databases": 3},
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
	integ := &authCheck{}
	c := newCollector(t, srv.URL, Registry{"postgres": integ})
	c.ProbesURL = srv.URL + "/ingest/v1/integrations/probes"
	members := []Member{{Name: "pg-0", Address: ln}}
	results := c.RunProbes(context.Background(), []Probe{
		{ID: "good", Type: "postgres", Members: members, Credential: &Credential{Username: "watchlog", Password: pw}},
		{ID: "wrong", Type: "postgres", Members: members, Credential: &Credential{Username: "watchlog", Password: "nope"}},
		{ID: "none", Type: "postgres", Members: members},
		{ID: "redis", Type: "redis", Members: members},
	})
	got := map[string]ProbeResult{}
	for _, r := range results {
		got[r.ID] = r
	}
	if g := got["good"]; !g.OK || g.Version != "16.4" || g.Facts["databases"] != 3 || len(g.Excess) != 1 {
		t.Errorf("good = %+v", g)
	}
	if g := got["wrong"]; g.OK || g.Error != "wrong password" {
		t.Errorf("wrong = %+v", g)
	}
	if g := got["none"]; g.OK || g.Error != "authentication required" {
		t.Errorf("none = %+v", g)
	}
	if g := got["redis"]; !g.OK {
		t.Errorf("TCP check of a listening member = %+v", g)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 1 || posted[0].Host != "docker-01" || len(posted[0].Results) != 4 {
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
