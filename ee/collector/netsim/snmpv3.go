// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"crypto/sha256"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// V3User is an SNMPv3 user a simulated device answers (1.0.4): its authentication and privacy
// protocols, with gosnmp.NoAuth and gosnmp.NoPriv for the lower security levels. A request at
// another level than the user's is refused, as a device configured for that level refuses it.
type V3User struct {
	Name     string
	Auth     gosnmp.SnmpV3AuthProtocol
	AuthPass string
	Priv     gosnmp.SnmpV3PrivProtocol
	PrivPass string
}

// level is the user's security level in msgFlags terms.
func (u V3User) level() gosnmp.SnmpV3MsgFlags {
	switch {
	case u.Auth == gosnmp.NoAuth || u.Auth == 0:
		return gosnmp.NoAuthNoPriv
	case u.Priv == gosnmp.NoPriv || u.Priv == 0:
		return gosnmp.AuthNoPriv
	}
	return gosnmp.AuthPriv
}

// QNAPUsers are what QTS's SNMP page can set up (1.0.4): HMAC-MD5 or HMAC-SHA, and "Use Privacy",
// which on QTS means DES. The simulated NAS answers these and nothing else.
func QNAPUsers(user, authPass, privPass string) []V3User {
	return []V3User{{Name: user, Auth: gosnmp.SHA, AuthPass: authPass, Priv: gosnmp.DES, PrivPass: privPass}}
}

// The USM statistics a report names (RFC 3414, 3.2).
const (
	usmUnsupportedSecLevels = ".1.3.6.1.6.3.15.1.1.1.0"
	usmUnknownUserNames     = ".1.3.6.1.6.3.15.1.1.3.0"
	usmUnknownEngineIDs     = ".1.3.6.1.6.3.15.1.1.4.0"
	usmWrongDigests         = ".1.3.6.1.6.3.15.1.1.5.0"
	usmDecryptionErrors     = ".1.3.6.1.6.3.15.1.1.6.0"
)

// engineID is the agent's own, made from its name: an enterprise-format ID (RFC 3411) with a
// text tail, the same after a restart so a poller's discovery stays valid.
func engineID(name string) string {
	h := sha256.Sum256([]byte(name))
	return string(append([]byte{0x80, 0x00, 0x1f, 0x88, 0x05}, h[:8]...))
}

// v3 answers one SNMPv3 message for the agent: an engine discovery, a report of what is wrong
// (unknown engine or user, a level the user doesn't have, a wrong digest, a privacy that fails),
// or the response. nil means silence: a message decrypted with the wrong privacy key turns into
// noise a real device can't parse, and drops (net-snmp, which QTS runs, is silent then).
func (s *Server) v3(a *Agent, raw []byte, users []V3User, now time.Time) []byte {
	plain := &gosnmp.GoSNMP{
		Version: gosnmp.Version3, SecurityModel: gosnmp.UserSecurityModel,
		// A name only to pass gosnmp's own checks: the packet's replaces it.
		SecurityParameters: &gosnmp.UsmSecurityParameters{UserName: "-", Logger: gosnmp.NewLogger(nil)},
		Logger:             gosnmp.NewLogger(nil),
	}
	hdr, _ := plain.SnmpDecodePacket(raw) // the header parses even when the PDU is encrypted
	if hdr == nil || hdr.Version != gosnmp.Version3 {
		return nil
	}
	in, ok := hdr.SecurityParameters.(*gosnmp.UsmSecurityParameters)
	if !ok {
		return nil
	}
	eid := engineID(a.Name)
	boots := uint32(1)
	since := uint32(now.Sub(a.start).Seconds())
	if since == 0 || now.Before(a.start) {
		since = 1
	}
	report := func(oid string, user string) []byte {
		res := &gosnmp.SnmpPacket{
			Version: gosnmp.Version3, MsgFlags: gosnmp.NoAuthNoPriv, SecurityModel: gosnmp.UserSecurityModel,
			MsgID: hdr.MsgID, RequestID: hdr.RequestID, PDUType: gosnmp.Report,
			ContextEngineID: eid, Logger: gosnmp.NewLogger(nil),
			SecurityParameters: &gosnmp.UsmSecurityParameters{
				AuthoritativeEngineID: eid, AuthoritativeEngineBoots: boots, AuthoritativeEngineTime: since,
				UserName: user, Logger: gosnmp.NewLogger(nil),
			},
			Variables: []gosnmp.SnmpPDU{{Name: oid, Type: gosnmp.Counter32, Value: uint32(1)}},
		}
		out, err := res.MarshalMsg()
		if err != nil {
			return nil
		}
		return out
	}
	// Engine discovery (RFC 3414, 4): no engine yet, or another one.
	if in.AuthoritativeEngineID != eid || in.UserName == "" {
		return report(usmUnknownEngineIDs, in.UserName)
	}
	var user *V3User
	for i := range users {
		if users[i].Name == in.UserName {
			user = &users[i]
		}
	}
	if user == nil {
		return report(usmUnknownUserNames, in.UserName)
	}
	asked := hdr.MsgFlags & gosnmp.AuthPriv
	if asked != user.level() {
		return report(usmUnsupportedSecLevels, in.UserName)
	}
	sp := &gosnmp.UsmSecurityParameters{
		AuthoritativeEngineID: eid, AuthoritativeEngineBoots: boots, AuthoritativeEngineTime: since,
		UserName: user.Name, AuthenticationProtocol: authOr(user.Auth), AuthenticationPassphrase: user.AuthPass,
		PrivacyProtocol: privOr(user.Priv), PrivacyPassphrase: user.PrivPass, Logger: gosnmp.NewLogger(nil),
	}
	dec := &gosnmp.GoSNMP{
		Version: gosnmp.Version3, SecurityModel: gosnmp.UserSecurityModel, MsgFlags: asked,
		SecurityParameters: sp, Logger: gosnmp.NewLogger(nil),
	}
	req, err := dec.UnmarshalTrap(raw, false)
	if err != nil {
		msg := err.Error()
		switch {
		// A digest that doesn't match, or one of another protocol's length (SHA-256's 24 bytes
		// where the user has SHA's 12): either way a wrong digest (RFC 3414, 3.2 step 6).
		case strings.Contains(msg, "not authentic"), strings.Contains(msg, "msgAuthenticationParameters"):
			return report(usmWrongDigests, in.UserName)
		case strings.Contains(msg, "decrypt"), strings.Contains(msg, "block size"), strings.Contains(msg, "cipher"):
			return report(usmDecryptionErrors, in.UserName)
		}
		return nil // noise after decryption: dropped, like a parse error on a real device
	}
	ag := a.Context("", req.ContextName)
	body, err := answer(ag, req, now)
	if err != nil {
		return nil
	}
	res := &gosnmp.SnmpPacket{
		Version: gosnmp.Version3, MsgFlags: asked, SecurityModel: gosnmp.UserSecurityModel,
		MsgID: hdr.MsgID, RequestID: req.RequestID, PDUType: gosnmp.GetResponse,
		ContextEngineID: eid, ContextName: req.ContextName, Logger: gosnmp.NewLogger(nil),
		Error: body.Error, ErrorIndex: body.ErrorIndex, Variables: body.Variables,
		SecurityParameters: &gosnmp.UsmSecurityParameters{
			AuthoritativeEngineID: eid, AuthoritativeEngineBoots: boots, AuthoritativeEngineTime: since,
			UserName: user.Name, AuthenticationProtocol: authOr(user.Auth), AuthenticationPassphrase: user.AuthPass,
			PrivacyProtocol: privOr(user.Priv), PrivacyPassphrase: user.PrivPass, Logger: gosnmp.NewLogger(nil),
		},
	}
	usm := res.SecurityParameters.(*gosnmp.UsmSecurityParameters)
	if err := usm.InitSecurityKeys(); err != nil {
		return nil
	}
	if err := usm.InitPacket(res); err != nil {
		return nil
	}
	out, err := res.MarshalMsg()
	if err != nil {
		return nil
	}
	return out
}

func authOr(p gosnmp.SnmpV3AuthProtocol) gosnmp.SnmpV3AuthProtocol {
	if p == 0 {
		return gosnmp.NoAuth
	}
	return p
}

func privOr(p gosnmp.SnmpV3PrivProtocol) gosnmp.SnmpV3PrivProtocol {
	if p == 0 {
		return gosnmp.NoPriv
	}
	return p
}
