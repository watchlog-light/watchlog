// SPDX-License-Identifier: AGPL-3.0-only

package logs

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/docker"
)

// DockerAPI is what the Docker reader needs of the client.
type DockerAPI interface {
	ListContainers(ctx context.Context, withSize bool) ([]docker.ContainerSummary, error)
	Logs(ctx context.Context, id string, tail int, follow bool) (io.ReadCloser, error)
}

// DockerReader reads a container's log through the Docker API (ADR-167). The container
// is found by name among the ones the daemon lists, so a request names nothing else.
type DockerReader struct {
	API DockerAPI
}

// Read implements Reader.
func (d DockerReader) Read(ctx context.Context, req Request, emit func(Raw)) error {
	if req.Previous {
		return &ReadError{Code: CodeNoPrevious, Detail: "Docker keeps one log per container"}
	}
	list, err := d.API.ListContainers(ctx, false)
	if err != nil {
		return err
	}
	id := ""
	for _, c := range list {
		if c.Name() == req.Container {
			id = c.ID
			break
		}
	}
	if id == "" {
		return &ReadError{Code: CodeNotFound, Detail: "no container of this name on this host"}
	}
	body, err := d.API.Logs(ctx, id, req.Lines, req.Follow)
	if err != nil {
		var se *docker.StatusError
		switch {
		case errors.Is(err, docker.ErrLogsOff):
			return &ReadError{Code: CodeDisabled, Detail: err.Error()}
		case errors.As(err, &se) && se.Code == http.StatusNotFound:
			return &ReadError{Code: CodeNotFound, Detail: "the container is gone"}
		case errors.As(err, &se) && (se.Code == http.StatusNotImplemented ||
			strings.Contains(se.Message, "does not support reading")):
			return &ReadError{Code: CodeDriver, Detail: se.Message}
		}
		return err
	}
	defer func() { _ = body.Close() }()
	// Close the stream when ctx ends, so a follow stops at once.
	stop := context.AfterFunc(ctx, func() { _ = body.Close() })
	defer stop()
	err = Demux(body, emit)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// Demux splits Docker's log stream into lines. A container without a TTY sends frames
// with an 8-byte header (stream, 0, 0, 0, size as big-endian uint32); one with a TTY
// sends raw bytes, and its lines carry no stream. With timestamps on, a raw stream
// starts with a digit, never with a frame's 0, 1 or 2.
func Demux(r io.Reader, emit func(Raw)) error {
	var head [8]byte
	n, err := io.ReadFull(r, head[:1])
	if n == 0 {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	if head[0] > 2 {
		return ScanLines(io.MultiReader(bytes.NewReader(head[:1]), r), func(s string) {
			emit(Raw{Text: s})
		})
	}
	partial := map[byte][]byte{}
	flush := func(stream byte, data []byte) {
		buf := append(partial[stream], data...)
		for {
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			emit(Raw{Stream: streamName(stream), Text: string(buf[:i])})
			buf = buf[i+1:]
		}
		// A line longer than rawLineBytes without a newline: send what there is.
		if len(buf) > rawLineBytes {
			emit(Raw{Stream: streamName(stream), Text: string(buf[:rawLineBytes])})
			buf = nil
		}
		partial[stream] = append([]byte(nil), buf...)
	}
	for first := true; ; first = false {
		var rest []byte
		if first {
			rest = head[1:]
		} else {
			rest = head[:]
		}
		if _, err := io.ReadFull(r, rest); err != nil {
			break
		}
		size := binary.BigEndian.Uint32(head[4:])
		data := make([]byte, min(size, 1<<20))
		if _, err := io.ReadFull(r, data); err != nil {
			break
		}
		if size > 1<<20 {
			if _, err := io.CopyN(io.Discard, r, int64(size-(1<<20))); err != nil {
				break
			}
		}
		flush(head[0], data)
	}
	for _, s := range []byte{1, 2} {
		if len(partial[s]) > 0 {
			emit(Raw{Stream: streamName(s), Text: string(partial[s])})
		}
	}
	return nil
}

func streamName(b byte) string {
	if b == 2 {
		return "stderr"
	}
	return "stdout"
}
