// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"log/slog"

	"github.com/watchlog-light/watchlog/agent/ext"
)

// Sample and Label are the collector's series types.
type (
	Sample = ext.Sample
	Label  = ext.Label
)

// Config is the network module's section of the collector's configuration (ADR-233): the
// devices this collector polls and the discovery jobs it was asked to run. It carries
// credentials: in memory only, never logged.
type Config struct {
	Version  string      `json:"version"`
	Devices  []Device    `json:"devices"`
	Discover []Discovery `json:"discover,omitempty"`
}

// Device is one network device this collector polls.
type Device struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Address string `json:"address"`
	// Protocol is "snmp" or "routeros".
	Protocol string `json:"protocol"`
	// Profile is a profile's name, or "" to match one from sysObjectID and sysDescr.
	Profile  string    `json:"profile,omitempty"`
	SNMP     *SNMPCred `json:"snmp,omitempty"`
	RouterOS *ROSCred  `json:"routeros,omitempty"`
	// Paused devices aren't polled (a changed certificate waiting for an Owner).
	Paused bool `json:"paused,omitempty"`
	// Linked are the ports the backend knows a link or a WatchLog node or server behind:
	// their series are kept while they are down.
	Linked []string `json:"linked,omitempty"`
}

// SNMPCred is an SNMP credential profile.
type SNMPCred struct {
	// Version is "3" (the default and the recommendation) or "2c".
	Version   string `json:"version"`
	Port      int    `json:"port,omitempty"`
	Community string `json:"community,omitempty"`
	User      string `json:"user,omitempty"`
	// AuthProto: SHA, SHA224, SHA256, SHA384, SHA512. PrivProto: AES, AES192, AES256.
	AuthProto string `json:"authProto,omitempty"`
	AuthKey   string `json:"authKey,omitempty"`
	PrivProto string `json:"privProto,omitempty"`
	PrivKey   string `json:"privKey,omitempty"`
}

// String keeps a credential out of any log line.
func (SNMPCred) String() string { return "snmp-credential(redacted)" }

// LogValue keeps a credential out of structured logs.
func (SNMPCred) LogValue() slog.Value { return slog.StringValue("snmp-credential(redacted)") }

// ROSCred is a RouterOS credential profile.
type ROSCred struct {
	User     string `json:"user"`
	Password string `json:"password"`
	// Transport is "rest" (HTTPS, the default), "api-ssl" (8729) or "api" (8728, only with
	// AllowPlain: the owner ticked "allow unencrypted on this network").
	Transport  string `json:"transport,omitempty"`
	Port       int    `json:"port,omitempty"`
	AllowPlain bool   `json:"allowPlain,omitempty"`
	// Pin is the device's certificate fingerprint (SHA-256, hex), "" before first contact.
	Pin string `json:"pin,omitempty"`
}

// String keeps a credential out of any log line.
func (ROSCred) String() string { return "routeros-credential(redacted)" }

// LogValue keeps a credential out of structured logs.
func (ROSCred) LogValue() slog.Value { return slog.StringValue("routeros-credential(redacted)") }

// Discovery is one "find the devices" request from the Add page: try each seed and each
// address of a range with each credential, and follow CDP, LLDP and MNDP from the seeds.
// Found devices are proposed, never added.
type Discovery struct {
	ID          string      `json:"id"`
	Seeds       []string    `json:"seeds"`
	Range       string      `json:"range,omitempty"`
	Neighbours  bool        `json:"neighbours"`
	Credentials []Candidate `json:"credentials"`
}

// Candidate is one credential profile a discovery tries.
type Candidate struct {
	ID       string    `json:"id"`
	Protocol string    `json:"protocol"`
	SNMP     *SNMPCred `json:"snmp,omitempty"`
	RouterOS *ROSCred  `json:"routeros,omitempty"`
}
