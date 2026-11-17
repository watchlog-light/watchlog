// SPDX-License-Identifier: AGPL-3.0-only

package logs

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func collect(t *testing.T, r ServerReader, req Request) ([]Raw, error) {
	t.Helper()
	var out []Raw
	err := r.Read(context.Background(), req, func(l Raw) { out = append(out, l) })
	return out, err
}

func TestJournal(t *testing.T) {
	var got []string
	r := ServerReader{Journal: func(_ context.Context, args ...string) (io.ReadCloser, func() error, error) {
		got = args
		lines := `{"__REALTIME_TIMESTAMP":"1794900000123456","MESSAGE":"orders started on :8080","PRIORITY":"6"}
{"__REALTIME_TIMESTAMP":"1794900001000000","MESSAGE":"panic: db password=hunter2 refused","PRIORITY":"3"}
{"__REALTIME_TIMESTAMP":"1794900002000000","MESSAGE":[104,105],"PRIORITY":"6"}
not json
`
		return io.NopCloser(strings.NewReader(lines)), func() error { return nil }, nil
	}}
	out, err := collect(t, r, Request{Unit: "orders.service", Lines: 50})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, " ") != "-u orders.service -n 50 -o json --no-pager -q" {
		t.Fatalf("args %v", got)
	}
	if len(out) != 3 || out[1].Stream != "stderr" || out[0].Stream != "" {
		t.Fatalf("%+v", out)
	}
	l, redacted, _ := Shape(out[1])
	if l.TS == nil || *l.TS != time.UnixMicro(1794900001000000).UTC().Format(time.RFC3339Nano) || !redacted || strings.Contains(l.Text, "hunter2") {
		t.Fatalf("%+v %v", l, redacted)
	}
	if !strings.HasSuffix(out[2].Text, " hi") {
		t.Fatalf("binary message: %q", out[2].Text)
	}
	// Never a command line built from a request: a bad unit name isn't run.
	if _, err := collect(t, r, Request{Unit: "x; rm -rf /"}); err == nil {
		t.Fatal("a bad unit name must be refused")
	}
	// A failing journalctl says so.
	r.Journal = func(context.Context, ...string) (io.ReadCloser, func() error, error) {
		return io.NopCloser(strings.NewReader("")), func() error { return errors.New("exit status 1") }, nil
	}
	var re *ReadError
	if _, err := collect(t, r, Request{Unit: "orders.service", Lines: 5}); !errors.As(err, &re) || re.Code != CodeReadFailed {
		t.Fatalf("%v", err)
	}
}

func TestGroupFiles(t *testing.T) {
	fsys := fstest.MapFS{
		"home/app/.pm2/logs/api-out.log":   {Data: []byte("listening on 3000\nGET /health 200\n")},
		"home/app/.pm2/logs/api-error.log": {Data: []byte("Error: connect ECONNREFUSED 127.0.0.1:5432\n")},
	}
	groups := map[string][2]string{"api": {"pm2-app.service", "pm2"}, "sync.py": {"", "script"}, "pool www": {"php8.3-fpm.service", "php-fpm"}}
	journalUnit := ""
	r := ServerReader{
		FS: fsys,
		Group: func(name string) (string, string, bool) {
			g, ok := groups[name]
			return g[0], g[1], ok
		},
		LogFiles: func(group, by string) map[string]string {
			if group == "api" && by == "pm2" {
				return map[string]string{"stdout": "home/app/.pm2/logs/api-out.log", "stderr": "home/app/.pm2/logs/api-error.log"}
			}
			return nil
		},
		Journal: func(_ context.Context, args ...string) (io.ReadCloser, func() error, error) {
			journalUnit = args[1]
			return io.NopCloser(strings.NewReader("")), func() error { return nil }, nil
		},
	}
	out, err := collect(t, r, Request{Group: "api", Lines: 1})
	if err != nil || len(out) != 2 || out[0].Text != "GET /health 200" || out[1].Stream != "stderr" {
		t.Fatalf("%+v %v", out, err)
	}
	// A group in a unit without its own files: its unit's journal.
	if _, err := collect(t, r, Request{Group: "pool www", Lines: 5}); err != nil || journalUnit != "php8.3-fpm.service" {
		t.Fatalf("%v %q", err, journalUnit)
	}
	// Started by hand: no log source, said plainly.
	var re *ReadError
	if _, err := collect(t, r, Request{Group: "sync.py", Lines: 5}); !errors.As(err, &re) || re.Code != CodeNoSource {
		t.Fatalf("%v", err)
	}
	if _, err := collect(t, r, Request{Group: "nope", Lines: 5}); !errors.As(err, &re) || re.Code != CodeNotFound {
		t.Fatalf("%v", err)
	}
}

func TestFollowAFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "worker.log")
	if err := os.WriteFile(p, []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := ServerReader{
		FS:       os.DirFS(dir),
		Group:    func(string) (string, string, bool) { return "", "supervisord", true },
		LogFiles: func(string, string) map[string]string { return map[string]string{"stdout": "worker.log"} },
		Poll:     10 * time.Millisecond,
	}
	ctx, cancel := context.WithCancel(context.Background())
	lines := make(chan string, 10)
	done := make(chan error, 1)
	go func() {
		done <- r.Read(ctx, Request{Group: "worker", Lines: 1, Follow: true}, func(l Raw) { lines <- l.Text })
	}()
	if got := <-lines; got != "two" {
		t.Fatalf("tail: %q", got)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString("three\npart")
	_ = f.Close()
	select {
	case got := <-lines:
		if got != "three" {
			t.Fatalf("followed: %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no new line followed")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
