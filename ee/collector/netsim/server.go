// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

// Server answers SNMP v2c and SNMPv3 (1.0.4) for many agents on one UDP socket each, as a lab
// of devices would. It answers GET, GETNEXT and GETBULK; anything else gets a genErr. Clock is
// the time the counters are read at (a replayed hour passes faster than an hour). Users are the
// SNMPv3 users every agent answers, unless the agent has its own (a QNAP's: SHA with DES).
type Server struct {
	Community string
	Users     []V3User
	Clock     func() time.Time
	mu        sync.Mutex
	conns     []net.PacketConn
}

// Listen serves an agent on addr ("127.0.0.1:0" picks a port) and returns its address.
func (s *Server) Listen(ctx context.Context, addr string, a *Agent) (string, error) {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.conns = append(s.conns, pc)
	s.mu.Unlock()
	go func() {
		<-ctx.Done()
		_ = pc.Close()
	}()
	go s.serve(pc, a)
	return pc.LocalAddr().String(), nil
}

func (s *Server) now() time.Time {
	if s.Clock != nil {
		return s.Clock()
	}
	return time.Now()
}

func (s *Server) serve(pc net.PacketConn, a *Agent) {
	buf := make([]byte, 65535)
	dec := &gosnmp.GoSNMP{Version: gosnmp.Version2c, Community: s.Community, Logger: gosnmp.NewLogger(nil)}
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if isV3(buf[:n]) {
			users := s.Users
			if len(a.Users) > 0 {
				users = a.Users
			}
			if out := s.v3(a, append([]byte(nil), buf[:n]...), users, s.now()); out != nil {
				_, _ = pc.WriteTo(out, from)
			}
			continue
		}
		req, err := dec.SnmpDecodePacket(buf[:n])
		if err != nil || req.Version != gosnmp.Version2c {
			continue
		}
		base, _, _ := cutAt(req.Community)
		if base != s.Community {
			continue // a wrong community gets no answer, as on a real device
		}
		ag := a.Context(req.Community, "")
		out, err := respond(ag, req, s.now())
		if err != nil {
			continue
		}
		_, _ = pc.WriteTo(out, from)
	}
}

func cutAt(c string) (string, string, bool) {
	for i := 0; i < len(c); i++ {
		if c[i] == '@' {
			return c[:i], c[i+1:], true
		}
	}
	return c, "", false
}

// isV3 reads the message's version: SEQUENCE, then INTEGER 3.
func isV3(b []byte) bool {
	if len(b) < 2 || b[0] != 0x30 {
		return false
	}
	i := 2
	if b[1]&0x80 != 0 {
		i += int(b[1] & 0x7f)
	}
	return len(b) > i+2 && b[i] == 0x02 && b[i+1] == 0x01 && b[i+2] == 0x03
}

// respond builds the answer to one v2c request.
func respond(a *Agent, req *gosnmp.SnmpPacket, now time.Time) ([]byte, error) {
	res, err := answer(a, req, now)
	if err != nil {
		return nil, err
	}
	res.Version, res.Community = req.Version, req.Community
	return res.MarshalMsg()
}

// answer is the response PDU to a request, whatever its version.
func answer(a *Agent, req *gosnmp.SnmpPacket, now time.Time) (*gosnmp.SnmpPacket, error) {
	res := &gosnmp.SnmpPacket{
		PDUType: gosnmp.GetResponse, RequestID: req.RequestID, Logger: gosnmp.NewLogger(nil),
	}
	switch req.PDUType {
	case gosnmp.GetRequest:
		for _, v := range req.Variables {
			res.Variables = append(res.Variables, a.Get(v.Name, now))
		}
	case gosnmp.GetNextRequest:
		for _, v := range req.Variables {
			res.Variables = append(res.Variables, a.Next(v.Name, now))
		}
	case gosnmp.GetBulkRequest:
		nr := int(req.NonRepeaters)
		for i, v := range req.Variables {
			if i < nr {
				res.Variables = append(res.Variables, a.Next(v.Name, now))
				continue
			}
			res.Variables = append(res.Variables, a.Bulk(v.Name, int(req.MaxRepetitions), now)...)
		}
	default:
		// SET and the rest: a simulated device is as read-only as WatchLog.
		res.Error = gosnmp.GenErr
		res.Variables = req.Variables
	}
	return res, nil
}
