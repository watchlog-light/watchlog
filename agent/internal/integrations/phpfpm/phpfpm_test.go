// SPDX-License-Identifier: AGPL-3.0-only

package phpfpm

import (
	"context"
	"net"
	"net/http"
	"net/http/fcgi"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
	"github.com/watchlog-light/watchlog/agent/internal/metrics"
)

// A pool's status page as PHP-FPM 8.3 answers `?json&full` (two workers).
const fullJSON = `{"pool":"www","process manager":"dynamic","start time":1794900000,"start since":3600,
"accepted conn":1520,"listen queue":3,"max listen queue":12,"listen queue len":511,"idle processes":1,
"active processes":4,"total processes":5,"max active processes":5,"max children reached":7,"slow requests":2,
"processes":[
{"pid":101,"state":"Running","start time":1794900000,"start since":3600,"requests":300,"request duration":2500000,
 "request method":"GET","request uri":"/checkout.php?token=secret-abc","content length":0,"user":"bob",
 "script":"/var/www/shop/checkout.php","last request cpu":0,"last request memory":0},
{"pid":102,"state":"Idle","start time":1794900000,"start since":3600,"requests":290,"request duration":40000,
 "request method":"GET","request uri":"/index.php","content length":0,"user":"-",
 "script":"/var/www/shop/index.php","last request cpu":12.5,"last request memory":4194304}]}`

// serve runs Go's FastCGI responder: the status page at statusPath, 404 elsewhere.
func serve(t *testing.T, network, addr, statusPath string) string {
	t.Helper()
	l, err := net.Listen(network, addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		_ = fcgi.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Go's responder takes the path from REQUEST_URI; PHP-FPM from SCRIPT_NAME. Both are sent.
			if r.URL.Path != statusPath || r.URL.RawQuery != "json&full" {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("File not found.\n"))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(fullJSON))
		}))
	}()
	if network == "unix" {
		return "unix:" + addr
	}
	return l.Addr().String()
}

func labels(s metrics.Sample) map[string]string {
	out := map[string]string{}
	for _, l := range s.Labels {
		out[l.Name] = l.Value
	}
	return out
}

func TestScrapeOverTCPAndSocket(t *testing.T) {
	for _, tc := range []struct{ network, addr, path string }{
		{"tcp", "127.0.0.1:0", "/status"},
		{"unix", filepath.Join(t.TempDir(), "fpm.sock"), "/fpm-status"},
	} {
		addr := serve(t, tc.network, tc.addr, tc.path)
		p := New()
		res := p.Scrape(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "www", Address: addr}}}, false)
		if res.State != integrations.StateOK {
			t.Fatalf("%s: %s %v", tc.network, res.Error, res.Members)
		}
		got := map[string]float64{}
		for _, s := range res.Samples {
			l := labels(s)
			if l["member"] != "www" || (s.Name != "watchlog_integration_connect_seconds" && l["pool"] != "www") {
				t.Fatalf("labels %v", l)
			}
			for k, v := range l {
				// Nothing from a request's URI, script or user is sent.
				if strings.Contains(v, "token") || strings.Contains(v, "/var/www") || strings.Contains(v, "bob") {
					t.Fatalf("%s carries %s=%q", s.Name, k, v)
				}
			}
			key := s.Name
			if l["state"] != "" {
				key += "{" + l["state"] + "}"
			}
			if l["quantile"] != "" {
				key += "{" + l["quantile"] + "}"
			}
			got[key] = s.Value
		}
		want := map[string]float64{
			"watchlog_phpfpm_accepted_connections_total":    1520,
			"watchlog_phpfpm_listen_queue":                  3,
			"watchlog_phpfpm_listen_queue_max":              12,
			"watchlog_phpfpm_processes{idle}":               1,
			"watchlog_phpfpm_processes{active}":             4,
			"watchlog_phpfpm_max_children_reached_total":    7,
			"watchlog_phpfpm_slow_requests_total":           2,
			"watchlog_phpfpm_request_duration_seconds{1}":   2.5,
			"watchlog_phpfpm_request_memory_bytes_max":      4194304,
			"watchlog_phpfpm_request_duration_seconds{0.5}": 2.5,
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s: %s = %v, want %v", tc.network, k, got[k], v)
			}
		}
		if res.Facts["pool"] != "www" || res.Facts["pm"] != "dynamic" {
			t.Errorf("facts %v", res.Facts)
		}
	}
}

func TestNoStatusPageIsSaidPlainly(t *testing.T) {
	addr := serve(t, "tcp", "127.0.0.1:0", "/elsewhere")
	now := time.Unix(1_794_900_000, 0)
	p := New()
	p.Now = func() time.Time { return now }
	target := integrations.Target{Members: []integrations.Member{{Name: "www", Address: addr}}}
	res := p.Scrape(context.Background(), target, false)
	if res.State != integrations.StateError || !strings.Contains(res.Error, "pm.status_path") {
		t.Fatalf("%s %s", res.State, res.Error)
	}
	if !res.Members[0].Up {
		t.Error("the pool answers FastCGI: up, with the status page missing")
	}
	// Remembered: the next scrape within Recheck doesn't ask again.
	res = p.Scrape(context.Background(), target, false)
	if !strings.Contains(res.Error, "pm.status_path") {
		t.Fatal(res.Error)
	}
}

func TestUnreachable(t *testing.T) {
	p := New()
	res := p.Scrape(context.Background(), integrations.Target{Members: []integrations.Member{{Name: "www", Address: "127.0.0.1:1"}}}, false)
	if res.State != integrations.StateError || !strings.HasPrefix(res.Error, "can't connect") {
		t.Fatalf("%s %q", res.State, res.Error)
	}
}

func TestParseCGI(t *testing.T) {
	code, body, err := parseCGI([]byte("Status: 404 Not Found\r\nContent-type: text/html\r\n\r\nFile not found.\n"))
	if err != nil || code != 404 || string(body) != "File not found.\n" {
		t.Fatal(code, string(body), err)
	}
	code, body, _ = parseCGI([]byte("Content-type: application/json\r\n\r\n{}"))
	if code != 200 || string(body) != "{}" {
		t.Fatal(code, string(body))
	}
}
