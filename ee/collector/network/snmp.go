// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// SNMP timing (ADR-233): a 5-second timeout and 2 retries per request.
const (
	SNMPTimeout = 5 * time.Second
	SNMPRetries = 2
	// MaxRepetitions is the GETBULK batch.
	MaxRepetitions = 25
)

// Var is one value read from a device.
type Var struct {
	OID   string // without a leading dot
	Type  gosnmp.Asn1BER
	Value any
}

// Reader is the only way the module talks SNMP: GET, GETNEXT and GETBULK. There is no SET:
// WatchLog never changes a device (ADR-233), and the wrapper has no way to build one.
type Reader interface {
	Get(ctx context.Context, oids []string) ([]Var, error)
	// Walk reads every value under root (GETBULK on v2c and v3), in order.
	Walk(ctx context.Context, root string, fn func(Var) error) error
	Close() error
}

// session wraps a gosnmp connection; the connection itself is never exposed.
type session struct {
	g   *gosnmp.GoSNMP
	rec *recConn
}

var (
	errSNMPAuth = errors.New("the device refused the SNMP credentials")
	errNoAnswer = errors.New("the device didn't answer SNMP")
	// What SNMPv3's reports say (1.0.4), each a refusal of the credentials in its own words,
	// so that the profile's test can say which value is wrong. The sentences are stable: the
	// backend reads them (ee/backend/src/network/routes-manage.ts, outcomeOf).
	errSNMPUser    = fmt.Errorf("%w: it doesn't know this SNMPv3 user", errSNMPAuth)
	errSNMPDigest  = fmt.Errorf("%w: the authentication password or protocol doesn't match", errSNMPAuth)
	errSNMPPrivacy = fmt.Errorf("%w: the privacy protocol or password doesn't match", errSNMPAuth)
	errSNMPLevel   = fmt.Errorf("%w: it wants another security level for this user", errSNMPAuth)
	// A device that answered the engine discovery and then nothing: what a device running
	// net-snmp (QNAP's QTS) does when it can't decrypt a request, a privacy mismatch.
	errSNMPSilent = errors.New("the device answered SNMPv3, then went silent: the privacy protocol or password doesn't match")
)

// recConn keeps the last message received, so that an SNMPv3 report gosnmp discards
// (it arrives unauthenticated, as RFC 3414 has it) can still be read for what it says.
type recConn struct {
	net.Conn
	last []byte
}

func (c *recConn) keep(b []byte) { c.last = append(c.last[:0], b...) }

func (c *recConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.keep(b[:n])
	}
	return n, err
}

func (c *recConn) ReadFrom(b []byte) (int, net.Addr, error) {
	if pc, ok := c.Conn.(net.PacketConn); ok {
		n, a, err := pc.ReadFrom(b)
		if n > 0 {
			c.keep(b[:n])
		}
		return n, a, err
	}
	n, err := c.Read(b)
	return n, c.RemoteAddr(), err
}

func (c *recConn) WriteTo(b []byte, addr net.Addr) (int, error) {
	if pc, ok := c.Conn.(net.PacketConn); ok {
		return pc.WriteTo(b, addr)
	}
	return c.Write(b)
}

// The USM statistics a report names (RFC 3414, 3.2).
const (
	usmUnsupportedSecLevels = "1.3.6.1.6.3.15.1.1.1.0"
	usmUnknownUserNames     = "1.3.6.1.6.3.15.1.1.3.0"
	usmWrongDigests         = "1.3.6.1.6.3.15.1.1.5.0"
	usmDecryptionErrors     = "1.3.6.1.6.3.15.1.1.6.0"
)

// reported reads the report in the last message received, "" when it wasn't one.
func (s *session) reported() string {
	if s.rec == nil || len(s.rec.last) == 0 {
		return ""
	}
	dec := &gosnmp.GoSNMP{
		Version: gosnmp.Version3, SecurityModel: gosnmp.UserSecurityModel,
		SecurityParameters: &gosnmp.UsmSecurityParameters{UserName: "-", Logger: gosnmp.NewLogger(nil)},
		Logger:             gosnmp.NewLogger(nil),
	}
	pkt, err := dec.SnmpDecodePacket(s.rec.last)
	if err != nil || pkt == nil || pkt.PDUType != gosnmp.Report || len(pkt.Variables) != 1 {
		return ""
	}
	return strings.TrimPrefix(pkt.Variables[0].Name, ".")
}

// explain turns an SNMPv3 failure into what the device meant: the report it sent, or silence
// after it answered the engine discovery.
func (s *session) explain(err error) error {
	if err == nil {
		return nil
	}
	if s.g.Version != gosnmp.Version3 {
		return classify(err)
	}
	oid := s.reported()
	switch {
	case errors.Is(err, gosnmp.ErrUnknownUsername):
		oid = usmUnknownUserNames
	case errors.Is(err, gosnmp.ErrWrongDigest):
		oid = usmWrongDigests
	case errors.Is(err, gosnmp.ErrDecryption):
		oid = usmDecryptionErrors
	case errors.Is(err, gosnmp.ErrUnknownSecurityLevel):
		oid = usmUnsupportedSecLevels
	}
	switch oid {
	case usmUnknownUserNames:
		return errSNMPUser
	case usmWrongDigests:
		return errSNMPDigest
	case usmDecryptionErrors:
		return errSNMPPrivacy
	case usmUnsupportedSecLevels:
		return errSNMPLevel
	}
	c := classify(err)
	if errors.Is(c, errNoAnswer) && s.g.MsgFlags&gosnmp.AuthPriv == gosnmp.AuthPriv {
		if usm, ok := s.g.SecurityParameters.(*gosnmp.UsmSecurityParameters); ok && usm.AuthoritativeEngineID != "" {
			return errSNMPSilent
		}
	}
	return c
}

// Dial opens an SNMP session to address with a credential. context names a v3 context
// ("vlan-20" on Cisco, for per-VLAN tables); community, when set, replaces the v2c
// community (Cisco's "community@vlan").
func Dial(address string, c *SNMPCred, v3Context, community string) (Reader, error) {
	if c == nil {
		return nil, errors.New("no SNMP credential")
	}
	port := uint16(161)
	if c.Port > 0 && c.Port < 65536 {
		port = uint16(c.Port)
	}
	// An address with its own port ("10.0.0.2:1161", a device behind NAT or a simulator).
	if h, p, ok := hostPort(address); ok {
		address, port = h, p
	}
	g := &gosnmp.GoSNMP{
		Target:             address,
		Port:               port,
		Timeout:            SNMPTimeout,
		Retries:            SNMPRetries,
		MaxRepetitions:     MaxRepetitions,
		MaxOids:            gosnmp.MaxOids,
		ExponentialTimeout: false,
	}
	switch c.Version {
	case "2c":
		g.Version = gosnmp.Version2c
		g.Community = c.Community
		if community != "" {
			g.Community = community
		}
	case "3", "":
		auth, err := authProto(c.AuthProto)
		if err != nil {
			return nil, err
		}
		priv, err := privProto(c.PrivProto)
		if err != nil {
			return nil, err
		}
		// The security level follows from the protocols (1.0.4): no authentication is
		// noAuthNoPriv (and then no privacy either), no privacy is authNoPriv.
		flags := gosnmp.AuthPriv
		switch {
		case auth == gosnmp.NoAuth:
			flags, priv = gosnmp.NoAuthNoPriv, gosnmp.NoPriv
		case priv == gosnmp.NoPriv:
			flags = gosnmp.AuthNoPriv
		}
		g.Version = gosnmp.Version3
		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags = flags
		g.ContextName = v3Context
		g.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 c.User,
			AuthenticationProtocol:   auth,
			AuthenticationPassphrase: c.AuthKey,
			PrivacyProtocol:          priv,
			PrivacyPassphrase:        c.PrivKey,
		}
	default:
		return nil, fmt.Errorf("SNMP version %q isn't supported (3 or 2c)", c.Version)
	}
	if err := g.Connect(); err != nil {
		return nil, err
	}
	rec := &recConn{Conn: g.Conn}
	g.Conn = rec
	return &session{g: g, rec: rec}, nil
}

// hostPort splits "host:port" (and "[v6]:port"); false for a bare host or IPv6 address.
func hostPort(address string) (string, uint16, bool) {
	h, p, err := net.SplitHostPort(address)
	if err != nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(p)
	if err != nil || n <= 0 || n > 65535 {
		return "", 0, false
	}
	return h, uint16(n), true
}

// authProto maps a profile's authentication. MD5 (1.0.4) is for older devices that offer
// nothing better, as QNAP's QTS offers HMAC-MD5 or HMAC-SHA only.
func authProto(s string) (gosnmp.SnmpV3AuthProtocol, error) {
	switch strings.ToUpper(s) {
	case "SHA", "SHA1", "":
		return gosnmp.SHA, nil
	case "SHA224":
		return gosnmp.SHA224, nil
	case "SHA256":
		return gosnmp.SHA256, nil
	case "SHA384":
		return gosnmp.SHA384, nil
	case "SHA512":
		return gosnmp.SHA512, nil
	case "MD5":
		return gosnmp.MD5, nil
	case "NONE":
		return gosnmp.NoAuth, nil
	}
	return 0, fmt.Errorf("SNMPv3 authentication %q isn't supported (MD5, SHA or SHA-2)", s)
}

// privProto maps a profile's privacy. DES (1.0.4) is what QTS means by "Use Privacy";
// AES192C and AES256C are AES with the key extension Cisco IOS uses for "priv aes 192|256"
// (Reeder's draft), where AES192 and AES256 follow Blumenthal's draft (net-snmp and most others).
func privProto(s string) (gosnmp.SnmpV3PrivProtocol, error) {
	switch strings.ToUpper(s) {
	case "AES", "AES128", "":
		return gosnmp.AES, nil
	case "AES192":
		return gosnmp.AES192, nil
	case "AES256":
		return gosnmp.AES256, nil
	case "AES192C":
		return gosnmp.AES192C, nil
	case "AES256C":
		return gosnmp.AES256C, nil
	case "DES":
		return gosnmp.DES, nil
	case "NONE":
		return gosnmp.NoPriv, nil
	}
	return 0, fmt.Errorf("SNMPv3 privacy %q isn't supported (AES or DES)", s)
}

func (s *session) Close() error { return s.g.Conn.Close() }

func (s *session) Get(ctx context.Context, oids []string) ([]Var, error) {
	s.g.Context = ctx
	pkt, err := s.g.Get(oids)
	if err != nil {
		return nil, s.explain(err)
	}
	return vars(pkt.Variables), nil
}

func (s *session) Walk(ctx context.Context, root string, fn func(Var) error) error {
	s.g.Context = ctx
	walk := func(pdu gosnmp.SnmpPDU) error {
		v := vars([]gosnmp.SnmpPDU{pdu})
		if len(v) == 0 {
			return nil
		}
		return fn(v[0])
	}
	var err error
	if s.g.Version == gosnmp.Version1 {
		err = s.g.Walk(root, walk)
	} else {
		err = s.g.BulkWalk(root, walk)
	}
	return s.explain(err)
}

func vars(pdus []gosnmp.SnmpPDU) []Var {
	out := make([]Var, 0, len(pdus))
	for _, p := range pdus {
		switch p.Type {
		case gosnmp.NoSuchObject, gosnmp.NoSuchInstance, gosnmp.EndOfMibView, gosnmp.Null:
			continue
		}
		out = append(out, Var{OID: strings.TrimPrefix(p.Name, "."), Type: p.Type, Value: p.Value})
	}
	return out
}

func classify(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no route to host") || strings.Contains(msg, "host is down") ||
		strings.Contains(msg, "network is unreachable"):
		return fmt.Errorf("%w (%s)", errNoAnswer, msg)
	case strings.Contains(msg, "authentication") || strings.Contains(msg, "unknown user") ||
		strings.Contains(msg, "wrong digest") || strings.Contains(msg, "decryption") ||
		strings.Contains(msg, "not authentic"):
		return fmt.Errorf("%w (%s)", errSNMPAuth, msg)
	}
	return err
}
