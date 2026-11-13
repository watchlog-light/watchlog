// SPDX-License-Identifier: AGPL-3.0-only

// Package logs reads a container's last log lines when someone asks (ADR-167): the agent
// long-polls the backend for requests, reads the lines through a Reader (the Kubernetes
// API's pods/log on the cluster-agent, the Docker API on a Docker host), redacts and cuts
// them here, before they leave the host, and posts them back. Lines are never written to
// disk, never buffered beyond one request, and never logged. It does not link client-go;
// the Kubernetes reader lives in package k8s (ADR-048).
package logs

import (
	"bufio"
	"context"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/watchlog-light/watchlog/agent/internal/redact"
)

// Limits of ADR-167.
const (
	MaxLines       = 1000
	MaxLineBytes   = 2048
	MaxAnswerBytes = 512 << 10
	FollowFor      = 5 * time.Minute
	// rawLineBytes bounds what is kept of one raw line before it is cut at MaxLineBytes.
	rawLineBytes = 8 << 10
)

// Request is one read the backend asks for (SPEC §8.2).
type Request struct {
	ID        string `json:"id"`
	Namespace string `json:"namespace,omitempty"`
	Pod       string `json:"pod,omitempty"`
	Container string `json:"container"`
	Previous  bool   `json:"previous"`
	Lines     int    `json:"lines"`
	Follow    bool   `json:"follow"`
}

// Line is one shaped line as posted to the backend.
type Line struct {
	TS     *string `json:"ts"`
	Stream string  `json:"stream,omitempty"`
	Text   string  `json:"text"`
}

// Raw is one line as a Reader gives it: no timestamp split, no redaction yet.
type Raw struct {
	Stream string // "stdout", "stderr", or "" when the runtime merges them
	Text   string // "<RFC 3339 timestamp> <text>" when the runtime adds one
}

// Error codes the backend shows (ADR-167).
const (
	CodeNotFound   = "container_not_found"
	CodeNoPrevious = "no_previous_run"
	CodeDriver     = "driver_unsupported"
	CodeReadFailed = "read_failed"
	CodeDisabled   = "disabled"
)

// ReadError is a read that failed in a way the reader understands.
type ReadError struct {
	Code   string
	Detail string
}

func (e *ReadError) Error() string { return e.Code + ": " + e.Detail }

// Reader reads a container's log: the last req.Lines lines, then, with req.Follow, new
// lines until ctx ends. It calls emit for every line in order.
type Reader interface {
	Read(ctx context.Context, req Request, emit func(Raw)) error
}

var (
	// CSI and OSC escape sequences (colours, cursor moves, titles).
	ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)
)

// Shape turns a raw line into what leaves the host: the timestamp split off, escapes
// and control characters removed, credentials redacted (ADR-047), and the text cut at
// MaxLineBytes on a UTF-8 boundary, ending in "…". It reports whether anything was
// redacted or cut.
func Shape(r Raw) (l Line, redacted, cut bool) {
	text := r.Text
	if i := strings.IndexByte(text, ' '); i > 0 && i <= 40 {
		if _, err := time.Parse(time.RFC3339Nano, text[:i]); err == nil {
			ts := text[:i]
			l.TS = &ts
			text = text[i+1:]
		}
	}
	text = strings.TrimRight(text, "\r\n")
	if !utf8.ValidString(text) {
		text = strings.ToValidUTF8(text, "�")
	}
	text = ansi.ReplaceAllString(text, "")
	text = strings.Map(func(r rune) rune {
		switch {
		case r == '\t':
			return ' '
		case unicode.IsControl(r):
			return -1
		}
		return r
	}, text)
	clean := redact.Text(text)
	redacted = clean != text
	if len(clean) > MaxLineBytes {
		const ellipsis = "…"
		c := MaxLineBytes - len(ellipsis)
		for c > 0 && !utf8.RuneStart(clean[c]) {
			c--
		}
		clean = clean[:c] + ellipsis
		cut = true
	}
	l.Text = clean
	l.Stream = r.Stream
	return l, redacted, cut
}

// Tail keeps the last lines of an answer within MaxAnswerBytes; the oldest go first.
type Tail struct {
	Lines     []Line
	Redacted  int
	Cut       int
	Truncated bool
	bytes     int
}

// Add shapes and appends one raw line.
func (t *Tail) Add(r Raw) {
	l, red, cut := Shape(r)
	if red {
		t.Redacted++
	}
	if cut {
		t.Cut++
	}
	t.Lines = append(t.Lines, l)
	t.bytes += len(l.Text)
	drop := 0
	for t.bytes > MaxAnswerBytes && drop < len(t.Lines) {
		t.bytes -= len(t.Lines[drop].Text)
		drop++
	}
	if drop > 0 {
		t.Lines = append(t.Lines[:0], t.Lines[drop:]...)
		t.Truncated = true
	}
}

// ScanLines calls fn for each line of r, keeping at most rawLineBytes of a long line (the
// rest is skipped, the line is cut later anyway).
func ScanLines(r io.Reader, fn func(string)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var buf []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(buf) < rawLineBytes {
			room := rawLineBytes - len(buf)
			if len(chunk) > room {
				buf = append(buf, chunk[:room]...)
			} else {
				buf = append(buf, chunk...)
			}
		}
		switch {
		case err == nil:
			fn(string(buf))
			buf = buf[:0]
		case errors.Is(err, bufio.ErrBufferFull):
			// The line goes on: keep reading it.
		case errors.Is(err, io.EOF):
			if len(buf) > 0 {
				fn(string(buf))
			}
			return nil
		default:
			if len(buf) > 0 {
				fn(string(buf))
			}
			return err
		}
	}
}
