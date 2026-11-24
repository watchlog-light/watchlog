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

// Server answers SNMP v2c for many agents on one UDP socket each, as a lab of devices would.
// It answers GET, GETNEXT and GETBULK; anything else gets a genErr. Clock is the time the
// counters are read at (a replayed hour passes faster than an hour).
type Server struct {
	Community string
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

// respond builds the answer to one request.
func respond(a *Agent, req *gosnmp.SnmpPacket, now time.Time) ([]byte, error) {
	res := &gosnmp.SnmpPacket{
		Version: req.Version, Community: req.Community, PDUType: gosnmp.GetResponse,
		RequestID: req.RequestID, Logger: gosnmp.NewLogger(nil),
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
	return res.MarshalMsg()
}
