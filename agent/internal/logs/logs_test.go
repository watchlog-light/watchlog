// SPDX-License-Identifier: AGPL-3.0-only

package logs

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/watchlog-light/watchlog/agent/internal/docker"
)

// Lines as the e2e stack printed them (kind 1.35 pods/log and Docker 29, timestamps on).
func TestShape(t *testing.T) {
	cases := []struct {
		name, in, ts, text string
		redacted           bool
	}{
		{"podinfo json", `2026-11-13T02:43:13.053130757Z {"level":"info","msg":"Starting HTTP Server.","addr":":9898"}`,
			"2026-11-13T02:43:13.053130757Z", `{"level":"info","msg":"Starting HTTP Server.","addr":":9898"}`, false},
		{"multi-byte", "2026-11-13T02:44:18.937338010Z سلام دنیا — héllo wörld 日本語 🚀 line 3",
			"2026-11-13T02:44:18.937338010Z", "سلام دنیا — héllo wörld 日本語 🚀 line 3", false},
		{"password=", "2026-11-13T02:44:18.937339469Z connecting with password=hunter2 to db",
			"2026-11-13T02:44:18.937339469Z", "connecting with password=*** to db", true},
		{"json password", `2026-11-13T02:44:18.937340719Z {"level":"info","user":"bob","password":"hunter2","token":"abc123"}`,
			"2026-11-13T02:44:18.937340719Z", `{"level":"info","user":"bob","password":"***","token":"***"}`, true},
		{"bearer", "2026-11-13T02:44:18.937341594Z Authorization: Bearer s3cr3tvalue",
			"2026-11-13T02:44:18.937341594Z", "Authorization: Bearer ***", true},
		{"url", "2026-11-13T02:44:18.937347885Z postgres://app:hunter2@db:5432/shop",
			"2026-11-13T02:44:18.937347885Z", "postgres://app:***@db:5432/shop", true},
		{"ansi", "2026-11-13T02:44:13.936621539Z \x1b[31mred error\x1b[0m done\r",
			"2026-11-13T02:44:13.936621539Z", "red error done", false},
		{"controls and tab", "a\tb\x00c\x07d", "", "a bcd", false},
		{"no timestamp", "unable to retrieve container logs for containerd://4ee5", "", "unable to retrieve container logs for containerd://4ee5", false},
		{"invalid utf-8", "bad \xff byte", "", "bad � byte", false},
	}
	for _, c := range cases {
		l, red, cut := Shape(Raw{Text: c.in})
		ts := ""
		if l.TS != nil {
			ts = *l.TS
		}
		if ts != c.ts || l.Text != c.text || red != c.redacted || cut {
			t.Errorf("%s: got ts=%q text=%q redacted=%v cut=%v", c.name, ts, l.Text, red, cut)
		}
	}
}

func TestShapeCutsOnRuneBoundary(t *testing.T) {
	long := strings.Repeat("ab", 400) + strings.Repeat("日", 1000) // 800 + 3000 bytes
	l, _, cut := Shape(Raw{Text: "2026-11-13T02:44:18Z " + long})
	if !cut || len(l.Text) > MaxLineBytes || !utf8.ValidString(l.Text) || !strings.HasSuffix(l.Text, "…") {
		t.Fatalf("cut=%v len=%d valid=%v", cut, len(l.Text), utf8.ValidString(l.Text))
	}
}

func TestTailKeepsNewestWithinBytes(t *testing.T) {
	var tl Tail
	line := strings.Repeat("x", 2000)
	for i := 0; i < 1000; i++ { // ~2 MB in all
		tl.Add(Raw{Text: line})
	}
	size := 0
	for _, l := range tl.Lines {
		size += len(l.Text)
	}
	if !tl.Truncated || size > MaxAnswerBytes || len(tl.Lines) != MaxAnswerBytes/2000 {
		t.Fatalf("truncated=%v size=%d lines=%d", tl.Truncated, size, len(tl.Lines))
	}
}

func TestScanLinesBoundsLongLines(t *testing.T) {
	in := strings.Repeat("y", 200_000) + "\nshort\nlast"
	var got []string
	if err := ScanLines(strings.NewReader(in), func(s string) { got = append(got, s) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || len(got[0]) != rawLineBytes || got[1] != "short\n" || got[2] != "last" {
		t.Fatalf("got %d lines, first %d bytes", len(got), len(got[0]))
	}
}

func frame(stream byte, s string) []byte {
	b := make([]byte, 8+len(s))
	b[0] = stream
	binary.BigEndian.PutUint32(b[4:], uint32(len(s)))
	copy(b[8:], s)
	return b
}

func TestDemuxMultiplexed(t *testing.T) {
	var in bytes.Buffer
	in.Write(frame(1, "2026-11-13T02:43:17.928792509Z cannot open /data/input.csv\n"))
	in.Write(frame(2, "2026-11-13T02:43:18Z stderr li"))
	in.Write(frame(1, "2026-11-13T02:43:18.190006551Z importing\n"))
	in.Write(frame(2, "ne 2\n"))
	in.Write(frame(1, "no newline at the end"))
	var got []Raw
	if err := Demux(&in, func(r Raw) { got = append(got, r) }); err != nil {
		t.Fatal(err)
	}
	want := []Raw{
		{"stdout", "2026-11-13T02:43:17.928792509Z cannot open /data/input.csv"},
		{"stdout", "2026-11-13T02:43:18.190006551Z importing"},
		{"stderr", "2026-11-13T02:43:18Z stderr line 2"},
		{"stdout", "no newline at the end"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d: %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDemuxTTY(t *testing.T) {
	var got []Raw
	_ = Demux(strings.NewReader("2026-11-13T02:43:17Z one\r\n2026-11-13T02:43:18Z two\n"), func(r Raw) { got = append(got, r) })
	if len(got) != 2 || got[0].Stream != "" || !strings.HasSuffix(got[1].Text, "two\n") {
		t.Fatalf("got %+v", got)
	}
}

type fakeDocker struct {
	list []docker.ContainerSummary
	body []byte
	err  error
	ids  []string
}

func (f *fakeDocker) ListContainers(context.Context, bool) ([]docker.ContainerSummary, error) {
	return f.list, nil
}

func (f *fakeDocker) Logs(_ context.Context, id string, _ int, _ bool) (io.ReadCloser, error) {
	f.ids = append(f.ids, id)
	if f.err != nil {
		return nil, f.err
	}
	return io.NopCloser(bytes.NewReader(f.body)), nil
}

func TestDockerReader(t *testing.T) {
	list := []docker.ContainerSummary{{ID: "9f752a941ee5b596", Names: []string{"/logs-e2e-printer"}}}
	f := &fakeDocker{list: list, body: frame(2, "2026-11-13T02:44:13Z stderr line 2\n")}
	var got []Raw
	err := DockerReader{API: f}.Read(context.Background(), Request{Container: "logs-e2e-printer", Lines: 5}, func(r Raw) { got = append(got, r) })
	if err != nil || len(got) != 1 || got[0].Stream != "stderr" || f.ids[0] != "9f752a941ee5b596" {
		t.Fatalf("err=%v got=%+v ids=%v", err, got, f.ids)
	}
	codes := map[string]error{
		CodeNotFound: DockerReader{API: f}.Read(context.Background(), Request{Container: "other"}, func(Raw) {}),
		CodeDriver: DockerReader{API: &fakeDocker{list: list, err: &docker.StatusError{Code: 501,
			Message: `{"message":"configured logging driver does not support reading"}`}}}.Read(context.Background(), Request{Container: "logs-e2e-printer"}, func(Raw) {}),
		CodeDisabled:   DockerReader{API: &fakeDocker{list: list, err: docker.ErrLogsOff}}.Read(context.Background(), Request{Container: "logs-e2e-printer"}, func(Raw) {}),
		CodeNoPrevious: DockerReader{API: f}.Read(context.Background(), Request{Container: "logs-e2e-printer", Previous: true}, func(Raw) {}),
	}
	for code, err := range codes {
		re, ok := err.(*ReadError)
		if !ok || re.Code != code {
			t.Errorf("%s: got %v", code, err)
		}
	}
}

// fakeReader emits fixed lines, then, when following, one line every 10 ms.
type fakeReader struct{ lines []string }

func (f fakeReader) Read(ctx context.Context, req Request, emit func(Raw)) error {
	for _, l := range f.lines {
		emit(Raw{Text: l})
	}
	if !req.Follow {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
			emit(Raw{Stream: "stdout", Text: "new line"})
		}
	}
}

type fakeBackend struct {
	mu      sync.Mutex
	queue   []Request
	posts   []chunk
	gone    atomic.Bool
	headers http.Header
}

func (b *fakeBackend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.headers = r.Header.Clone()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/ingest/v1/logs/requests":
		if len(b.queue) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"requests": b.queue})
		b.queue = nil
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/ingest/v1/logs/"):
		var c chunk
		_ = json.NewDecoder(r.Body).Decode(&c)
		b.posts = append(b.posts, c)
		if b.gone.Load() {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// lastHeaders reads the last request's headers under the lock: the runner keeps polling.
func (b *fakeBackend) lastHeaders() http.Header {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.headers.Clone()
}

func (b *fakeBackend) snapshot() []chunk {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]chunk(nil), b.posts...)
}

func TestRunnerServesATail(t *testing.T) {
	be := &fakeBackend{queue: []Request{{ID: "r1", Namespace: "logs-e2e", Pod: "printer", Container: "main", Lines: 5000}}}
	srv := httptest.NewServer(be)
	defer srv.Close()
	lines := []string{"2026-11-13T02:44:18Z password=hunter2"}
	for i := 0; i < 700; i++ {
		lines = append(lines, "2026-11-13T02:44:19Z "+strings.Repeat("z", 400))
	}
	r := &Runner{Base: srv.URL, Token: "tok", AgentID: "cluster-agent", UserAgent: "test",
		Reader: fakeReader{lines: lines}, Log: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Run(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		posts := be.snapshot()
		if n := len(posts); n > 0 && posts[n-1].Done {
			total := 0
			for _, p := range posts[:n-1] {
				if p.Done || p.Redacted != 0 {
					t.Fatalf("counts or done before the last part: %+v", p)
				}
				total += len(p.Lines)
			}
			total += len(posts[n-1].Lines)
			if total != 701 || posts[n-1].Redacted != 1 || posts[0].Lines[0].Text != "password=***" || n < 2 {
				t.Fatalf("posts=%d total=%d redacted=%d first=%q", n, total, posts[n-1].Redacted, posts[0].Lines[0].Text)
			}
			if h := be.lastHeaders(); h.Get("Authorization") != "Bearer tok" || h.Get("X-WatchLog-Agent") != "cluster-agent" {
				t.Fatalf("headers %v", h)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no final post: %d posts", len(be.snapshot()))
}

func TestRunnerFollowStopsWhenTheReaderLeaves(t *testing.T) {
	be := &fakeBackend{queue: []Request{{ID: "r2", Container: "printer", Lines: 10, Follow: true}}}
	srv := httptest.NewServer(be)
	defer srv.Close()
	r := &Runner{Base: srv.URL, Token: "tok", AgentID: "host-1", Host: "host-1", UserAgent: "test",
		Reader: fakeReader{lines: []string{"first"}}, Log: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Run(ctx)
	waitFor(t, func() bool { return len(be.snapshot()) >= 2 })
	posts := be.snapshot()
	if posts[0].Lines[0].Text != "first" || posts[0].Done {
		t.Fatalf("first post %+v", posts[0])
	}
	be.gone.Store(true)
	waitFor(t, func() bool { return r.active() == 0 })
	n := len(be.snapshot())
	time.Sleep(1500 * time.Millisecond)
	if len(be.snapshot()) != n {
		t.Fatalf("kept posting after 410")
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out")
}
