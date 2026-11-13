// SPDX-License-Identifier: AGPL-3.0-only

package logs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// PollWait is how long the backend may hold a poll open (SPEC §8.2).
const PollWait = 25 * time.Second

// MaxConcurrent bounds the reads one agent serves at once.
const MaxConcurrent = 8

const (
	postLines     = 500
	postBytes     = 256 << 10
	flushEvery    = time.Second
	keepAliveEver = 15 * time.Second
	readTimeout   = 25 * time.Second
)

// errGone means the reader left (410) or the request is unknown (404): stop sending.
var errGone = errors.New("the reader left")

// Runner polls for requests and serves them.
type Runner struct {
	// Base is the backend's base URL (scheme://host[:port]).
	Base      string
	Token     string
	AgentID   string
	UserAgent string
	// Host is the Docker host's name; empty for the cluster-agent.
	Host   string
	Reader Reader
	Log    *slog.Logger
	Client *http.Client

	sem chan struct{}
}

// Run polls until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	if r.Client == nil {
		r.Client = &http.Client{Timeout: PollWait + 15*time.Second}
	}
	r.sem = make(chan struct{}, MaxConcurrent)
	backoff := 5 * time.Second
	for ctx.Err() == nil {
		reqs, status, err := r.poll(ctx)
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return
			}
			r.Log.Debug("logs: poll failed", "err", err)
			sleep(ctx, backoff)
			backoff = min(backoff*2, time.Minute)
			continue
		case status == http.StatusUnauthorized, status == http.StatusNotFound:
			// A refused token, or a backend older than 0.5.0: look again later.
			sleep(ctx, 5*time.Minute)
			continue
		case status == http.StatusTooManyRequests || status >= 500:
			sleep(ctx, backoff)
			backoff = min(backoff*2, time.Minute)
			continue
		}
		backoff = 5 * time.Second
		for _, req := range reqs {
			select {
			case r.sem <- struct{}{}:
				go func(req Request) {
					defer func() { <-r.sem }()
					r.serve(ctx, req)
				}(req)
			default:
				_ = r.post(ctx, req.ID, chunk{Error: &chunkError{Code: CodeReadFailed, Detail: "the agent is serving too many log reads; try again"}})
			}
		}
	}
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (r *Runner) poll(ctx context.Context) ([]Request, int, error) {
	q := url.Values{"wait": {fmt.Sprint(int(PollWait / time.Second))}}
	if r.Host != "" {
		q.Set("host", r.Host)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Base+"/ingest/v1/logs/requests?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, err
	}
	r.headers(req)
	res, err := r.Client.Do(req)
	if err != nil {
		return nil, 0, r.redactToken(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return nil, res.StatusCode, nil
	}
	var body struct {
		Requests []Request `json:"requests"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return nil, 0, fmt.Errorf("reading log requests: %w", err)
	}
	out := body.Requests[:0]
	for _, q := range body.Requests {
		if q.ID == "" || q.Container == "" {
			continue
		}
		q.Lines = max(1, min(q.Lines, MaxLines))
		out = append(out, q)
	}
	return out, http.StatusOK, nil
}

func (r *Runner) headers(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("User-Agent", r.UserAgent)
	req.Header.Set("X-WatchLog-Agent", r.AgentID)
}

func (r *Runner) redactToken(err error) error {
	if r.Token == "" || !strings.Contains(err.Error(), r.Token) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), r.Token, "<redacted>"))
}

type chunkError struct {
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

type chunk struct {
	Lines     []Line      `json:"lines"`
	Redacted  int         `json:"redacted,omitempty"`
	Cut       int         `json:"cut,omitempty"`
	Truncated bool        `json:"truncated,omitempty"`
	Done      bool        `json:"done,omitempty"`
	Error     *chunkError `json:"error,omitempty"`
}

func (r *Runner) post(ctx context.Context, id string, c chunk) error {
	if c.Lines == nil {
		c.Lines = []Line{}
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.Base+"/ingest/v1/logs/"+url.PathEscape(id), bytes.NewReader(b))
	if err != nil {
		return err
	}
	r.headers(req)
	req.Header.Set("Content-Type", "application/json")
	res, err := r.Client.Do(req)
	if err != nil {
		return r.redactToken(err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	_ = res.Body.Close()
	switch res.StatusCode {
	case http.StatusNoContent, http.StatusOK:
		return nil
	case http.StatusGone, http.StatusNotFound:
		return errGone
	}
	return fmt.Errorf("posting log lines answered %d", res.StatusCode)
}

// postAll sends lines in parts of at most postLines lines and postBytes; the counts and
// done (or the error) go with the last part.
func (r *Runner) postAll(ctx context.Context, id string, t *Tail, done bool, cerr *chunkError) error {
	lines := t.Lines
	for {
		n, size := 0, 0
		for n < len(lines) && n < postLines && size+len(lines[n].Text) <= postBytes {
			size += len(lines[n].Text)
			n++
		}
		if n == 0 && len(lines) > 0 {
			n = 1
		}
		last := n == len(lines)
		c := chunk{Lines: lines[:n]}
		if last {
			c.Redacted, c.Cut, c.Truncated, c.Done, c.Error = t.Redacted, t.Cut, t.Truncated, done && cerr == nil, cerr
		}
		if err := r.post(ctx, id, c); err != nil {
			return err
		}
		lines = lines[n:]
		if last {
			return nil
		}
	}
}

func asChunkError(err error) *chunkError {
	var re *ReadError
	if errors.As(err, &re) {
		return &chunkError{Code: re.Code, Detail: clip(re.Detail)}
	}
	return &chunkError{Code: CodeReadFailed, Detail: clip(err.Error())}
}

func clip(s string) string {
	if len(s) > 500 {
		s = s[:500]
	}
	return strings.ToValidUTF8(s, "")
}

// serve reads one request and posts its lines. Nothing is kept once it returns.
func (r *Runner) serve(ctx context.Context, req Request) {
	if !req.Follow {
		rctx, cancel := context.WithTimeout(ctx, readTimeout)
		defer cancel()
		var t Tail
		err := r.Reader.Read(rctx, req, t.Add)
		var cerr *chunkError
		if err != nil && (!errors.Is(err, context.DeadlineExceeded) || len(t.Lines) == 0) {
			cerr = asChunkError(err)
		}
		if perr := r.postAll(ctx, req.ID, &t, true, cerr); perr != nil && !errors.Is(perr, errGone) {
			r.Log.Warn("logs: posting lines failed", "err", perr)
		}
		return
	}
	r.follow(ctx, req)
}

// follow streams the tail and then new lines, posted about once a second, for at most
// FollowFor; it stops when the reader leaves (410).
func (r *Runner) follow(ctx context.Context, req Request) {
	fctx, cancel := context.WithTimeout(ctx, FollowFor+10*time.Second)
	defer cancel()
	var mu sync.Mutex
	pending := &Tail{}
	readDone := make(chan error, 1)
	go func() {
		readDone <- r.Reader.Read(fctx, req, func(raw Raw) {
			mu.Lock()
			pending.Add(raw)
			mu.Unlock()
		})
	}()
	take := func() *Tail {
		mu.Lock()
		defer mu.Unlock()
		t := pending
		pending = &Tail{}
		return t
	}
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	lastPost := time.Now()
	for {
		select {
		case err := <-readDone:
			var cerr *chunkError
			if err != nil && fctx.Err() == nil {
				cerr = asChunkError(err)
			}
			_ = r.postAll(ctx, req.ID, take(), true, cerr)
			return
		case <-tick.C:
			t := take()
			if len(t.Lines) == 0 && t.Redacted == 0 && time.Since(lastPost) < keepAliveEver {
				continue
			}
			lastPost = time.Now()
			// An empty post is the keep-alive that learns when the reader left.
			if err := r.postAll(fctx, req.ID, t, false, nil); err != nil {
				cancel()
				if err := <-readDone; err != nil {
					r.Log.Debug("logs: follow ended", "reason", "the reader left")
				}
				return
			}
		}
	}
}

// active is the number of reads being served (for tests).
func (r *Runner) active() int { return len(r.sem) }
