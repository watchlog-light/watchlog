// SPDX-License-Identifier: AGPL-3.0-only

// Package integrations is the integrations collector (ADR-131): it pulls its targets
// from the backend, reads each monitored service with a fixed, read-only set of
// statements, and pushes metrics and status like the agents do.
package integrations

import "log/slog"

// Config is what the backend serves at /ingest/v1/integrations/config. It may carry
// credentials (ADR-133): it is kept in memory only and never logged.
type Config struct {
	Version string   `json:"version"`
	Scrape  Scrape   `json:"scrape"`
	Targets []Target `json:"targets"`
	// Probes are connection tests the connect drawer asked for (ADR-134): each is tried
	// every 5 s, and at once when it is new or "Check now" was pressed.
	Probes []Probe `json:"probes,omitempty"`
}

// Scrape holds the scrape tiers: every IntervalS seconds, heavy views every HeavyEvery scrapes.
type Scrape struct {
	IntervalS  int `json:"interval_s"`
	HeavyEvery int `json:"heavy_every"`
}

// Target is one monitored service instance.
type Target struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Name     string   `json:"name"`
	Members  []Member `json:"members"`
	Settings Settings `json:"settings"`
	// Credential is how to log in, when the service needs a user (ADR-133, ADR-134).
	Credential *Credential `json:"credential,omitempty"`
	// Auth is the credential resolved for this scrape (a Secret or file read); never sent.
	Auth *Auth `json:"-"`
}

// Credential is a user and its password, or where the password lives: a key of a
// Kubernetes Secret the collector was granted, or a file under SecretsDir on the
// Docker host.
type Credential struct {
	Username string     `json:"username,omitempty"`
	Password string     `json:"password,omitempty"`
	Secret   *SecretRef `json:"secret,omitempty"`
	File     string     `json:"file,omitempty"`
}

// String keeps a credential out of any log line or error built with %v.
func (Credential) String() string { return "credential(redacted)" }

// LogValue keeps a credential out of structured logs.
func (Credential) LogValue() slog.Value { return slog.StringValue("credential(redacted)") }

// SecretRef names one key of one Secret.
type SecretRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Key       string `json:"key"`
}

// Auth is a resolved user and password, in memory only.
type Auth struct {
	Username string
	Password string
}

// String keeps a password out of any log line.
func (Auth) String() string { return "auth(redacted)" }

// LogValue keeps a password out of structured logs.
func (Auth) LogValue() slog.Value { return slog.StringValue("auth(redacted)") }

// Probe is one connection test: the service's members and the access to try.
type Probe struct {
	ID         string      `json:"id"`
	Type       string      `json:"type"`
	Members    []Member    `json:"members"`
	Credential *Credential `json:"credential,omitempty"`
	// Requested changes when "Check now" is pressed.
	Requested string `json:"requested"`
}

// ProbeResults is posted to /ingest/v1/integrations/probes.
type ProbeResults struct {
	Host    string        `json:"host"`
	Results []ProbeResult `json:"results"`
}

// ProbeResult is what one try found: whether it could connect (and log in), the
// service's version, a few facts for the drawer, and privileges beyond what's needed.
type ProbeResult struct {
	ID string `json:"id"`
	OK bool   `json:"ok"`
	// Code says what kind of outcome it is, so the drawer can give the fix (Probe* below).
	Code    string         `json:"code"`
	Error   string         `json:"error,omitempty"`
	Version string         `json:"version,omitempty"`
	Facts   map[string]any `json:"facts,omitempty"`
	Excess  []string       `json:"excess,omitempty"`
	// Missing lists the privileges or settings a logged-in user lacks (ProbePermission).
	Missing []string `json:"missing,omitempty"`
}

// Probe outcome codes. A probe passes only with ProbeOK: for a service with a user, that
// means the integration logged in and checked the user's privileges.
const (
	ProbeOK = "ok"
	// No member accepted a connection.
	ProbeUnreachable = "unreachable"
	// The user or password was refused.
	ProbeAuthFailed = "auth_failed"
	// Logged in, but the user lacks privileges (Missing names them).
	ProbePermission = "permission_missing"
	// The password couldn't be read from its Secret or file.
	ProbeCredential = "credential_unavailable" //nolint:gosec // G101: an outcome code, not a credential
	// The port answers, but this type can't log in yet (no integration for it).
	ProbeLoginUntested = "login_untested"
	// Anything else; Error says what.
	ProbeError = "error"
)

// Member is one pod or container of a service, or the address of a service added by hand.
type Member struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// Settings are the per-service switches (ADR-138).
type Settings struct {
	QueryText bool `json:"query_text"`
}

// Status is posted to /ingest/v1/integrations/status every scrape; it is also the
// collector's heartbeat.
type Status struct {
	Host          string         `json:"host"`
	Mode          string         `json:"mode"`
	Version       string         `json:"version"`
	ConfigVersion string         `json:"config_version"`
	Self          SelfStatus     `json:"self"`
	Targets       []TargetStatus `json:"targets"`
}

// SelfStatus is the collector's own footprint, for the budget (ADR-131), and on
// Kubernetes its namespace and ServiceAccount, for the commands that grant it one
// Secret (ADR-134).
type SelfStatus struct {
	RSSBytes       float64 `json:"rss_bytes,omitempty"`
	CPUSeconds     float64 `json:"cpu_seconds,omitempty"`
	Series         int     `json:"series"`
	Namespace      string  `json:"namespace,omitempty"`
	ServiceAccount string  `json:"service_account,omitempty"`
}

// TargetStatus is one target's outcome.
type TargetStatus struct {
	ID             string         `json:"id"`
	State          string         `json:"state"` // ok, error, connecting
	Error          string         `json:"error,omitempty"`
	ServiceVersion string         `json:"service_version,omitempty"`
	Members        []MemberStatus `json:"members,omitempty"`
	Permissions    []Permission   `json:"permissions,omitempty"`
	// Extra is what a page shows that isn't a metric: slow log entries (normalised,
	// ADR-138), client addresses to map to workloads. Bounded by each integration.
	Extra map[string]any `json:"extra,omitempty"`
}

// MemberStatus says whether one member answered.
type MemberStatus struct {
	Name  string `json:"name"`
	Up    bool   `json:"up"`
	Error string `json:"error,omitempty"`
}

// Permission is a tab (or "tab/panel") that can't be filled and the privilege or setting
// it needs (ADR-134).
type Permission struct {
	Tab     string `json:"tab"`
	Missing string `json:"missing"`
}

// Status values.
const (
	StateOK         = "ok"
	StateError      = "error"
	StateConnecting = "connecting"
)

// Limits the backend accepts in a status report.
const (
	maxErrorLen   = 512
	maxMembers    = 16
	maxTargets    = 500
	maxPermission = 16
)
