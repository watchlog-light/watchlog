// SPDX-License-Identifier: AGPL-3.0-only

package certs

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// ErrNotTLS: the port answered, but not with TLS (or refused STARTTLS).
var ErrNotTLS = errors.New("not TLS")

// Dialer opens a TCP connection (net.Dialer's DialContext, or a fake in tests).
type Dialer func(ctx context.Context, network, addr string) (net.Conn, error)

// Probe reads the certificate chain a port presents (ADR-222): a TLS handshake that verifies
// nothing and sends nothing else, after the protocol's STARTTLS step where the port needs one.
type Probe struct {
	Dial    Dialer
	Timeout time.Duration
	// Steps names the STARTTLS step a port needs (tests); nil: by the port's number.
	Steps func(port uint16) string
}

// Presented is what one handshake returned.
type Presented struct {
	Chain []*x509.Certificate
	// Proto is how TLS was reached: tls, smtp, imap, pop3, postgresql, mysql.
	Proto string
}

// starttlsFor is the STARTTLS step a port's well-known number needs; "" for TLS at once.
func starttlsFor(port uint16) string {
	switch port {
	case 25, 587:
		return "smtp"
	case 143:
		return "imap"
	case 110:
		return "pop3"
	case 5432:
		return "postgresql"
	case 3306:
		return "mysql"
	}
	return ""
}

// Handshake opens addr ("host:port") and returns the chain it presents for sni ("" for none).
func (p Probe) Handshake(ctx context.Context, addr string, port uint16, sni string) (Presented, error) {
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 1500 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	dial := p.Dial
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	conn, err := dial(ctx, "tcp", addr)
	if err != nil {
		return Presented{}, err
	}
	defer func() { _ = conn.Close() }()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	proto := "tls"
	steps := p.Steps
	if steps == nil {
		steps = starttlsFor
	}
	if step := steps(port); step != "" {
		if err := starttls(conn, step); err != nil {
			return Presented{}, fmt.Errorf("%w: %s: %v", ErrNotTLS, step, err)
		}
		proto = step
	}
	// Nothing is verified here: the chain is examined afterwards (chain.go), as it was sent.
	tc := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, ServerName: sni, MinVersion: tls.VersionTLS10}) //nolint:gosec // read-only inspection, no data sent
	if err := tc.HandshakeContext(ctx); err != nil {
		var re tls.RecordHeaderError
		if errors.As(err, &re) {
			return Presented{}, fmt.Errorf("%w: %v", ErrNotTLS, err)
		}
		return Presented{}, err
	}
	state := tc.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return Presented{}, ErrNotTLS
	}
	return Presented{Chain: state.PeerCertificates, Proto: proto}, nil
}

// starttls brings a plain connection to the point where the TLS handshake starts.
func starttls(conn net.Conn, step string) error {
	r := bufio.NewReader(conn)
	line := func() (string, error) {
		s, err := r.ReadString('\n')
		if len(s) > 512 {
			return "", errors.New("line too long")
		}
		return s, err
	}
	switch step {
	case "smtp":
		if s, err := line(); err != nil || !strings.HasPrefix(s, "220") {
			return fmt.Errorf("greeting %q: %v", trim(s), err)
		}
		if _, err := io.WriteString(conn, "EHLO watchlog\r\n"); err != nil {
			return err
		}
		for i := 0; i < 50; i++ { // the EHLO answer's lines end with "250 " (a space)
			s, err := line()
			if err != nil {
				return err
			}
			if len(s) > 3 && s[3] == ' ' {
				break
			}
		}
		if _, err := io.WriteString(conn, "STARTTLS\r\n"); err != nil {
			return err
		}
		if s, err := line(); err != nil || !strings.HasPrefix(s, "220") {
			return fmt.Errorf("starttls %q: %v", trim(s), err)
		}
	case "imap":
		if s, err := line(); err != nil || !strings.HasPrefix(s, "* OK") {
			return fmt.Errorf("greeting %q: %v", trim(s), err)
		}
		if _, err := io.WriteString(conn, "w1 STARTTLS\r\n"); err != nil {
			return err
		}
		for i := 0; i < 20; i++ {
			s, err := line()
			if err != nil {
				return err
			}
			if strings.HasPrefix(s, "w1 ") {
				if !strings.HasPrefix(s, "w1 OK") {
					return fmt.Errorf("starttls %q", trim(s))
				}
				break
			}
		}
	case "pop3":
		if s, err := line(); err != nil || !strings.HasPrefix(s, "+OK") {
			return fmt.Errorf("greeting %q: %v", trim(s), err)
		}
		if _, err := io.WriteString(conn, "STLS\r\n"); err != nil {
			return err
		}
		if s, err := line(); err != nil || !strings.HasPrefix(s, "+OK") {
			return fmt.Errorf("stls %q: %v", trim(s), err)
		}
	case "postgresql":
		// SSLRequest: length 8, code 80877103; the server answers 'S' (yes) or 'N'.
		if _, err := conn.Write([]byte{0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f}); err != nil {
			return err
		}
		b, err := r.ReadByte()
		if err != nil || b != 'S' {
			return fmt.Errorf("ssl refused (%q): %v", b, err)
		}
	case "mysql":
		return mysqlSSL(conn, r)
	}
	if r.Buffered() > 0 { // the server spoke before the handshake: not ours to read
		return errors.New("unexpected data before the handshake")
	}
	return nil
}

// mysqlSSL reads the server's handshake (protocol 10) and answers with an SSL request.
func mysqlSSL(conn net.Conn, r *bufio.Reader) error {
	head := make([]byte, 4)
	if _, err := io.ReadFull(r, head); err != nil {
		return err
	}
	n := int(head[0]) | int(head[1])<<8 | int(head[2])<<16
	if n < 32 || n > 1<<14 {
		return fmt.Errorf("handshake length %d", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return err
	}
	if body[0] != 10 {
		return fmt.Errorf("protocol %d", body[0])
	}
	// protocol(1) version(NUL-terminated) thread id(4) auth part 1(8) filler(1) caps low(2)
	i := 1
	for i < len(body) && body[i] != 0 {
		i++
	}
	i += 1 + 4 + 8 + 1
	if i+2 > len(body) {
		return errors.New("short handshake")
	}
	const clientSSL, protocol41, secureConn = 0x0800, 0x0200, 0x8000
	if binary.LittleEndian.Uint16(body[i:])&clientSSL == 0 {
		return errors.New("the server doesn't offer TLS")
	}
	req := make([]byte, 4+32)
	req[0], req[3] = 32, 1 // payload length 32, sequence 1
	binary.LittleEndian.PutUint32(req[4:], clientSSL|protocol41|secureConn)
	binary.LittleEndian.PutUint32(req[8:], 1<<24) // max packet
	req[12] = 33                                  // utf8_general_ci
	_, err := conn.Write(req)
	return err
}

func trim(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 60 {
		return s[:60]
	}
	return s
}
