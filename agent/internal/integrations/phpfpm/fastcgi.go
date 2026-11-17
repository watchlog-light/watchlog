// SPDX-License-Identifier: AGPL-3.0-only

package phpfpm

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net/textproto"
	"strconv"
	"strings"
)

// FastCGI record types (the FastCGI 1.0 specification).
const (
	typeBeginRequest = 1
	typeEndRequest   = 3
	typeParams       = 4
	typeStdin        = 5
	typeStdout       = 6
	typeStderr       = 7
	roleResponder    = 1
	requestID        = 1
)

func writeRecord(w io.Writer, typ byte, content []byte) error {
	if len(content) > 0xffff {
		return errors.New("fastcgi: record too large")
	}
	pad := (8 - len(content)%8) % 8
	//nolint:gosec // bounded above: the length fits two bytes, the padding is below 8
	h := []byte{1, typ, 0, requestID, byte(len(content) >> 8), byte(len(content)), byte(pad), 0}
	if _, err := w.Write(h); err != nil {
		return err
	}
	if _, err := w.Write(content); err != nil {
		return err
	}
	_, err := w.Write(make([]byte, pad))
	return err
}

func pairLen(b *bytes.Buffer, n int) {
	if n < 128 {
		b.WriteByte(byte(n)) //nolint:gosec // below 128
		return
	}
	_ = binary.Write(b, binary.BigEndian, uint32(n)|1<<31) //nolint:gosec // our own short parameters
}

func encodeParams(params [][2]string) []byte {
	var b bytes.Buffer
	for _, p := range params {
		pairLen(&b, len(p[0]))
		pairLen(&b, len(p[1]))
		b.WriteString(p[0])
		b.WriteString(p[1])
	}
	return b.Bytes()
}

// Get sends one GET for path?query as a FastCGI responder request on rw and returns the
// CGI status and body. PHP-FPM serves its status page for SCRIPT_NAME = pm.status_path.
func Get(rw io.ReadWriter, path, query string) (int, []byte, error) {
	params := encodeParams([][2]string{
		{"GATEWAY_INTERFACE", "CGI/1.1"},
		{"REQUEST_METHOD", "GET"},
		{"SCRIPT_NAME", path},
		{"SCRIPT_FILENAME", path},
		{"REQUEST_URI", path + "?" + query},
		{"QUERY_STRING", query},
		{"SERVER_PROTOCOL", "HTTP/1.1"},
		{"SERVER_SOFTWARE", "watchlog-integrations"},
		{"REMOTE_ADDR", "127.0.0.1"},
	})
	w := bufio.NewWriter(rw)
	if err := writeRecord(w, typeBeginRequest, []byte{0, roleResponder, 0, 0, 0, 0, 0, 0}); err != nil {
		return 0, nil, err
	}
	if err := writeRecord(w, typeParams, params); err != nil {
		return 0, nil, err
	}
	if err := writeRecord(w, typeParams, nil); err != nil {
		return 0, nil, err
	}
	if err := writeRecord(w, typeStdin, nil); err != nil {
		return 0, nil, err
	}
	if err := w.Flush(); err != nil {
		return 0, nil, err
	}
	var stdout bytes.Buffer
	r := bufio.NewReader(rw)
	h := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, h); err != nil {
			return 0, nil, err
		}
		n := int(binary.BigEndian.Uint16(h[4:6]))
		pad := int(h[6])
		body := make([]byte, n+pad)
		if _, err := io.ReadFull(r, body); err != nil {
			return 0, nil, err
		}
		switch h[1] {
		case typeStdout:
			if stdout.Len()+n > MaxBody {
				return 0, nil, errors.New("the status page is too large")
			}
			stdout.Write(body[:n])
		case typeStderr:
			// PHP's warnings: not the answer.
		case typeEndRequest:
			return parseCGI(stdout.Bytes())
		}
	}
}

// parseCGI splits a CGI response into its status (200 without a Status header) and body.
func parseCGI(b []byte) (int, []byte, error) {
	tp := textproto.NewReader(bufio.NewReader(bytes.NewReader(b)))
	hdr, err := tp.ReadMIMEHeader()
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, nil, err
	}
	code := 200
	if s := hdr.Get("Status"); s != "" {
		if c, err := strconv.Atoi(strings.Fields(s)[0]); err == nil {
			code = c
		}
	}
	body, _ := io.ReadAll(tp.R)
	return code, body, nil
}
