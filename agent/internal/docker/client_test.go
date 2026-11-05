// SPDX-License-Identifier: AGPL-3.0-only

package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Fixtures: real responses from Docker 29.9.2 (API 1.56) on Ubuntu 24.04, Env redacted.
const fixtures = "testdata/docker-29"

func TestAllowlist(t *testing.T) {
	allowed := []string{
		"/_ping", "/version", "/v1.56/containers/json", "/v1.41/containers/0b869286b1d0/json",
		"/v1.56/containers/0b869286b1d05b4ac849f1406237936c359e223c9fa5efc1f4cd666d4a25e100/stats", "/v1.56/events",
	}
	for _, p := range allowed {
		if !Allowed(http.MethodGet, p) {
			t.Errorf("GET %s should be allowed", p)
		}
	}
	denied := map[string]string{
		"/v1.56/info": "GET", "/v1.56/containers/abc123abc123/exec": "GET", "/v1.56/containers/create": "GET",
		"/v1.56/containers/0b869286b1d0/logs": "GET", "/v1.56/images/json": "GET", "/v1.56/containers/my-name/json": "GET",
		"/v1.56/containers/0b869286b1d0/kill": "POST", "/v1.56/containers/json": "POST", "/_ping": "HEAD",
		"/v1.56/containers/json/../../info": "GET",
	}
	for p, m := range denied {
		if Allowed(m, p) {
			t.Errorf("%s %s must be denied", m, p)
		}
	}
}

// fakeDaemon serves fixture files on a unix socket and records request paths.
func fakeDaemon(t *testing.T, routes map[string]string) (*Client, *[]string) {
	t.Helper()
	// macOS limits unix socket paths to ~104 bytes; t.TempDir() is too long there.
	dir, err := os.MkdirTemp("/tmp", "wld")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "docker.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var paths []string
	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		mu.Unlock()
		file, ok := routes[r.URL.Path]
		if !ok {
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		b, err := os.ReadFile(filepath.Join(fixtures, file))
		if err != nil {
			t.Error(err)
		}
		_, _ = w.Write(b)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return New(sock), &paths
}

func TestNegotiateAndListFromRealFixtures(t *testing.T) {
	c, paths := fakeDaemon(t, map[string]string{
		"/version":               "version.json",
		"/v1.56/containers/json": "containers-size.json",
	})
	v, err := c.Negotiate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v.Version != "29.9.2" || v.KernelVersion != "6.8.0-142-generic" || c.APIVersion() != "1.56" {
		t.Errorf("version = %+v, api %s", v, c.APIVersion())
	}
	list, err := c.ListContainers(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]ContainerSummary{}
	for _, s := range list {
		byName[s.Name()] = s
	}
	web := byName["demo-web-1"]
	if web.State != "running" || web.Health == nil || web.Health.Status != "healthy" ||
		web.Labels["com.docker.compose.project"] != "demo" || web.Labels["com.docker.compose.service"] != "web" {
		t.Errorf("demo-web-1 = %+v", web)
	}
	if len(web.Ports) == 0 || web.Ports[0].PublicPort != 8081 || web.SizeRw == nil {
		t.Errorf("ports/size = %+v %v", web.Ports, web.SizeRw)
	}
	if byName["fx-unhealthy"].Health.Status != "unhealthy" || byName["fx-crashloop"].State != "restarting" {
		t.Errorf("states: %+v %+v", byName["fx-unhealthy"], byName["fx-crashloop"])
	}
	if !strings.Contains((*paths)[1], "all=1") || !strings.Contains((*paths)[1], "size=1") {
		t.Errorf("list query = %s", (*paths)[1])
	}
}

func TestInspectDecodesOnlyAllowlistedFields(t *testing.T) {
	const id = "0b869286b1d05b4ac849f1406237936c359e223c9fa5efc1f4cd666d4a25e100"
	c, _ := fakeDaemon(t, map[string]string{"/v1.56/containers/" + id + "/json": "inspect-demo-cache-1.json"})
	st, err := c.Inspect(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if st.State.Pid != 16580 || !st.State.Running || st.RestartCount != 0 || st.State.StartedAt == "" {
		t.Errorf("state = %+v", st)
	}
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), "Env") || strings.Contains(string(b), "REDACTED") {
		t.Error("environment must never be decoded")
	}
}

func TestDeniedRequestsAreNeverSent(t *testing.T) {
	c, paths := fakeDaemon(t, map[string]string{})
	err := c.getJSON(context.Background(), "/v1.56/info", nil, &struct{}{})
	if !errors.Is(err, ErrNotAllowed) || len(*paths) != 0 {
		t.Errorf("err = %v, requests = %v", err, *paths)
	}
	if _, err := c.Inspect(context.Background(), "../../info"); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("path traversal not rejected: %v", err)
	}
}

func TestEventsFromRealStream(t *testing.T) {
	f, err := os.Open(filepath.Join(fixtures, "events-filtered.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var actions []string
	if err := decodeEvents(f, func(e Event) { actions = append(actions, e.Action+":"+e.Actor.Attributes["name"]) }); err != nil {
		t.Fatal(err)
	}
	if strings.Join(actions, ",") != "die:demo-worker-1,start:demo-worker-1,restart:demo-worker-1" {
		t.Errorf("actions = %v", actions)
	}
	// The unfiltered stream contains healthcheck exec_* events every few seconds.
	raw, _ := os.ReadFile(filepath.Join(fixtures, "events.jsonl"))
	if !strings.Contains(string(raw), `"Action":"exec_start`) {
		t.Error("expected healthcheck exec events in the unfiltered fixture")
	}
}

func TestMinVersion(t *testing.T) {
	for _, tc := range [][3]string{{"1.41", "1.56", "1.41"}, {"1.60", "1.56", "1.56"}, {"", "1.56", "1.56"}, {"1.56", "1.56", "1.56"}} {
		if got := minVersion(tc[0], tc[1]); got != tc[2] {
			t.Errorf("minVersion(%s, %s) = %s", tc[0], tc[1], got)
		}
	}
}

// Diagnosis fixtures: captured 2026-10-31 on the Lima VM watchlog-fresh (Docker 29.9.2).
func TestInspectDecodesHealthAndExitDetails(t *testing.T) {
	ids := map[string]string{}
	routes := map[string]string{}
	for _, name := range []string{"fx-unhealthy", "fx-exited", "fx-oom", "fx-crashloop"} {
		b, err := os.ReadFile(filepath.Join(fixtures, "diagnosis", "inspect-"+name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var head struct {
			ID string `json:"Id"`
		}
		_ = json.Unmarshal(b, &head)
		ids[name] = head.ID
		routes["/v1.56/containers/"+head.ID+"/json"] = "diagnosis/inspect-" + name + ".json"
	}
	c, _ := fakeDaemon(t, routes)
	inspect := func(name string) ContainerState {
		st, err := c.Inspect(context.Background(), ids[name])
		if err != nil {
			t.Fatal(err)
		}
		return st
	}

	u := inspect("fx-unhealthy")
	h, hc := u.State.Health, u.Config.Healthcheck
	if h == nil || h.Status != "unhealthy" || h.FailingStreak != 3 || len(h.Log) != 3 {
		t.Fatalf("health = %+v", h)
	}
	if last := h.Log[2]; last.ExitCode != 1 || !strings.Contains(last.Output, "Connection refused") || last.Start == "" {
		t.Errorf("last probe = %+v", last)
	}
	if hc == nil || hc.Test[0] != "CMD-SHELL" || hc.Interval != 5e9 || hc.Timeout != 3e9 || hc.StartPeriod != 2e9 || hc.Retries != 3 {
		t.Errorf("healthcheck = %+v", hc)
	}

	if e := inspect("fx-exited"); e.State.Status != "exited" || e.State.ExitCode != 1 || e.State.FinishedAt == "" || e.Config.Healthcheck != nil {
		t.Errorf("exited = %+v", e.State)
	}
	if o := inspect("fx-oom"); !o.State.OOMKilled || o.State.ExitCode != 137 {
		t.Errorf("oom = %+v", o.State)
	}
	if r := inspect("fx-crashloop"); !r.State.Restarting || r.State.ExitCode != 2 || r.RestartCount != 4 {
		t.Errorf("restarting = %+v (restarts %d)", r.State, r.RestartCount)
	}

	b, _ := json.Marshal(u)
	if strings.Contains(string(b), "Env") || strings.Contains(string(b), "REDACTED") || strings.Contains(string(b), "Cmd") {
		t.Error("environment and command line must never be decoded")
	}
}
