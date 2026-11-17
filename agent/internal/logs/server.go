// SPDX-License-Identifier: AGPL-3.0-only

package logs

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ServerReader reads a server's logs on demand (ADR-208): a systemd service's journal
// (`journalctl -u <unit> -o json`, run with the agent's own capabilities), the files pm2
// and supervisord write a process group's output to, and containers through Docker. Every
// line goes through Shape like a container's: redacted, never stored.
type ServerReader struct {
	// Docker reads containers; nil on a server without Docker.
	Docker Reader
	// Group says a process group's unit and the rule that named it (procs.Collector.GroupInfo).
	Group func(name string) (unit, by string, ok bool)
	// LogFiles lists a group's log files by stream (procs.LogFiles over the host's root).
	LogFiles func(group, by string) map[string]string
	// FS opens those files; the host's root.
	FS fs.FS
	// Journal runs journalctl with these arguments (tests replace it).
	Journal func(ctx context.Context, args ...string) (io.ReadCloser, func() error, error)
	// Poll is how often a followed file is checked for new lines.
	Poll time.Duration
}

var unitName = regexp.MustCompile(`^[A-Za-z0-9@._:\\-]{1,250}\.service$`)

// Read implements Reader.
func (s ServerReader) Read(ctx context.Context, req Request, emit func(Raw)) error {
	switch {
	case req.Unit == "" && req.Group == "":
		if s.Docker == nil {
			return &ReadError{Code: CodeNotFound, Detail: "Docker isn't reachable on this server"}
		}
		return s.Docker.Read(ctx, req, emit)
	case req.Previous:
		return &ReadError{Code: CodeNoPrevious, Detail: "the journal and log files are one history"}
	case req.Group != "":
		unit, by, ok := "", "", false
		if s.Group != nil {
			unit, by, ok = s.Group(req.Group)
		}
		if !ok {
			return &ReadError{Code: CodeNotFound, Detail: "no process group of this name on this server"}
		}
		if by == "pm2" || by == "supervisord" {
			if files := s.LogFiles(req.Group, by); len(files) > 0 {
				return s.files(ctx, files, req, emit)
			}
		}
		if unit == "" {
			return &ReadError{Code: CodeNoSource, Detail: "started outside systemd, pm2 and supervisord: its output goes nowhere WatchLog can read"}
		}
		return s.journal(ctx, unit, req, emit)
	default:
		return s.journal(ctx, req.Unit, req, emit)
	}
}

// journalLine is the part of `journalctl -o json` that is read.
type journalLine struct {
	Realtime string          `json:"__REALTIME_TIMESTAMP"`
	Message  json.RawMessage `json:"MESSAGE"`
	Priority string          `json:"PRIORITY"`
}

func (s ServerReader) journal(ctx context.Context, unit string, req Request, emit func(Raw)) error {
	if !unitName.MatchString(unit) {
		return &ReadError{Code: CodeNotFound, Detail: "not a service name"}
	}
	args := []string{"-u", unit, "-n", strconv.Itoa(max(1, req.Lines)), "-o", "json", "--no-pager", "-q"}
	if req.Follow {
		args = append(args, "-f")
	}
	run := s.Journal
	if run == nil {
		run = runJournalctl
	}
	out, wait, err := run(ctx, args...)
	if err != nil {
		return &ReadError{Code: CodeReadFailed, Detail: err.Error()}
	}
	defer func() { _ = out.Close() }()
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), rawLineBytes*4)
	for sc.Scan() {
		var j journalLine
		if json.Unmarshal(sc.Bytes(), &j) != nil {
			continue
		}
		var msg string
		if json.Unmarshal(j.Message, &msg) != nil {
			// A binary message is an array of bytes in the journal's JSON.
			var b []byte
			if json.Unmarshal(j.Message, &b) != nil {
				continue
			}
			msg = string(b)
		}
		raw := Raw{Text: msg}
		if us, err := strconv.ParseInt(j.Realtime, 10, 64); err == nil {
			raw.Text = time.UnixMicro(us).UTC().Format(time.RFC3339Nano) + " " + msg
		}
		// syslog priorities 0–3 (emerg … err) read as the error stream.
		if p, err := strconv.Atoi(j.Priority); err == nil && p <= 3 {
			raw.Stream = "stderr"
		}
		emit(raw)
	}
	if ctx.Err() != nil {
		return nil
	}
	if err := wait(); err != nil {
		return &ReadError{Code: CodeReadFailed, Detail: "journalctl: " + err.Error()}
	}
	return sc.Err()
}

func runJournalctl(ctx context.Context, args ...string) (io.ReadCloser, func() error, error) {
	bin, err := exec.LookPath("journalctl")
	if err != nil {
		return nil, nil, errors.New("journalctl isn't installed")
	}
	cmd := exec.CommandContext(ctx, bin, args...) //nolint:gosec // fixed binary; the unit name is checked above
	cmd.Env = []string{"SYSTEMD_COLORS=0", "LANG=C.UTF-8"}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return out, cmd.Wait, nil
}

// files tails a group's log files (stdout and stderr), then follows them when asked.
func (s ServerReader) files(ctx context.Context, files map[string]string, req Request, emit func(Raw)) error {
	type tail struct {
		stream, path string
		offset       int64
	}
	var tails []*tail
	for _, stream := range []string{"stdout", "stderr"} {
		p, ok := files[stream]
		if !ok {
			continue
		}
		lines, size, err := lastLines(s.FS, p, max(1, req.Lines))
		if err != nil {
			continue
		}
		// Each file's last lines; their order between files is unknown (no timestamps).
		for _, l := range lines {
			emit(Raw{Stream: stream, Text: l})
		}
		tails = append(tails, &tail{stream: stream, path: p, offset: size})
	}
	if len(tails) == 0 {
		return &ReadError{Code: CodeReadFailed, Detail: "the log files can't be read"}
	}
	if !req.Follow {
		return nil
	}
	poll := s.Poll
	if poll <= 0 {
		poll = time.Second
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(poll):
		}
		for _, t := range tails {
			t.offset = readFrom(s.FS, t.path, t.offset, func(l string) { emit(Raw{Stream: t.stream, Text: l}) })
		}
	}
}

// lastLines is a file's last n lines (read from its end, at most 1 MiB) and its size.
func lastLines(fsys fs.FS, p string, n int) ([]string, int64, error) {
	f, err := fsys.Open(p)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := st.Size()
	const window = 1 << 20
	start := max(0, size-window)
	var b []byte
	if ra, ok := f.(io.ReaderAt); ok {
		b = make([]byte, size-start)
		if _, err := ra.ReadAt(b, start); err != nil && !errors.Is(err, io.EOF) {
			return nil, 0, err
		}
	} else {
		all, err := io.ReadAll(f)
		if err != nil {
			return nil, 0, err
		}
		b = all[start:]
	}
	text := strings.TrimRight(string(b), "\n")
	if text == "" {
		return nil, size, nil
	}
	lines := strings.Split(text, "\n")
	if start > 0 && len(lines) > 1 {
		lines = lines[1:] // the first is cut
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, size, nil
}

// readFrom emits the whole lines written since offset and returns the new offset; a file
// that shrank (rotated or truncated) is read from its start.
func readFrom(fsys fs.FS, p string, offset int64, emit func(string)) int64 {
	f, err := fsys.Open(p)
	if err != nil {
		return offset
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil {
		return offset
	}
	if st.Size() < offset {
		offset = 0
	}
	if st.Size() == offset {
		return offset
	}
	ra, ok := f.(io.ReaderAt)
	if !ok {
		return st.Size()
	}
	b := make([]byte, min(st.Size()-offset, 1<<20))
	n, _ := ra.ReadAt(b, offset)
	chunk := string(b[:n])
	last := strings.LastIndexByte(chunk, '\n')
	if last < 0 {
		return offset // no whole line yet
	}
	for _, l := range strings.Split(chunk[:last], "\n") {
		emit(l)
	}
	return offset + int64(last) + 1
}

// HostFS is the host's root as an fs.FS (the agent reads files below it, never writes).
func HostFS(root string) fs.FS { return os.DirFS(root) }
