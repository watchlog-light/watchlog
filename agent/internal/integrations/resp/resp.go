// SPDX-License-Identifier: AGPL-3.0-only

// Package resp is a minimal Redis protocol (RESP2) client for the integrations
// collector (ADR-131): it sends the fixed, read-only commands the Redis integration
// names and reads their replies. It never sends anything the backend chose.
package resp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// Error is a reply the server sent as an error ("-NOPERM …", "-WRONGPASS …").
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// Code is the error's first word: ERR, NOPERM, WRONGPASS, NOAUTH, …
func (e *Error) Code() string {
	code, _, _ := strings.Cut(e.Msg, " ")
	return code
}

// IsCode tells whether err is a server error with this code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code() == code
}

// Conn is one connection.
type Conn struct {
	c       net.Conn
	r       *bufio.Reader
	timeout time.Duration
}

// Dial connects; every command then has its own deadline of timeout.
func Dial(ctx context.Context, address string, timeout time.Duration) (*Conn, error) {
	d := net.Dialer{Timeout: timeout}
	c, err := d.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	return &Conn{c: c, r: bufio.NewReaderSize(c, 32<<10), timeout: timeout}, nil
}

// Close closes the connection.
func (c *Conn) Close() error { return c.c.Close() }

// MaxReply bounds one reply, so a huge CLIENT LIST or SLOWLOG can't exhaust memory.
const MaxReply = 8 << 20

// Do sends one command and reads its reply: string, int64, []any, nil, or *Error as
// the error.
func (c *Conn) Do(ctx context.Context, args ...string) (any, error) {
	deadline := time.Now().Add(c.timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := c.c.SetDeadline(deadline); err != nil {
		return nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := io.WriteString(c.c, b.String()); err != nil {
		return nil, err
	}
	budget := MaxReply
	return c.read(&budget, 0)
}

// String runs a command whose reply is a string.
func (c *Conn) String(ctx context.Context, args ...string) (string, error) {
	v, err := c.Do(ctx, args...)
	if err != nil {
		return "", err
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("%s: unexpected reply %T", args[0], v)
	}
	return s, nil
}

func (c *Conn) line() (string, error) {
	l, err := c.r.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(strings.TrimSuffix(l, "\n"), "\r"), nil
}

var errTooBig = errors.New("reply too large")

func (c *Conn) read(budget *int, depth int) (any, error) {
	if depth > 8 {
		return nil, errors.New("reply nested too deep")
	}
	l, err := c.line()
	if err != nil {
		return nil, err
	}
	if l == "" {
		return nil, errors.New("empty reply line")
	}
	*budget -= len(l)
	if *budget < 0 {
		return nil, errTooBig
	}
	switch l[0] {
	case '+':
		return l[1:], nil
	case '-':
		return nil, &Error{Msg: l[1:]}
	case ':':
		return strconv.ParseInt(l[1:], 10, 64)
	case '$':
		n, err := strconv.Atoi(l[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		if *budget -= n; *budget < 0 {
			return nil, errTooBig
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(c.r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(l[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		if n > 1<<20 {
			return nil, errTooBig
		}
		out := make([]any, 0, n)
		for range n {
			v, err := c.read(budget, depth+1)
			// An error inside an array (a failed command in a pipeline) is a value.
			var e *Error
			if errors.As(err, &e) {
				out = append(out, e)
				continue
			}
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unknown reply type %q", l[0])
	}
}
