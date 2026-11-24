// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"errors"
	"fmt"
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
	g *gosnmp.GoSNMP
}

var (
	errSNMPAuth = errors.New("the device refused the SNMP credentials")
	errNoAnswer = errors.New("the device didn't answer SNMP")
)

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
		flags := gosnmp.AuthPriv
		if priv == gosnmp.NoPriv {
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
	return &session{g: g}, nil
}

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
	}
	return 0, fmt.Errorf("SNMPv3 authentication %q isn't supported (SHA or SHA-2)", s)
}

func privProto(s string) (gosnmp.SnmpV3PrivProtocol, error) {
	switch strings.ToUpper(s) {
	case "AES", "AES128", "":
		return gosnmp.AES, nil
	case "AES192":
		return gosnmp.AES192, nil
	case "AES256":
		return gosnmp.AES256, nil
	case "NONE":
		return gosnmp.NoPriv, nil
	}
	return 0, fmt.Errorf("SNMPv3 privacy %q isn't supported (AES)", s)
}

func (s *session) Close() error { return s.g.Conn.Close() }

func (s *session) Get(ctx context.Context, oids []string) ([]Var, error) {
	s.g.Context = ctx
	pkt, err := s.g.Get(oids)
	if err != nil {
		return nil, classify(err)
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
	return classify(err)
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
		strings.Contains(msg, "wrong digest") || strings.Contains(msg, "decryption"):
		return fmt.Errorf("%w (%s)", errSNMPAuth, msg)
	}
	return err
}
