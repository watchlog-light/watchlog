// SPDX-License-Identifier: AGPL-3.0-only

// Package integrations is the integrations collector (ADR-131): it pulls its targets
// from the backend, reads each monitored service with a fixed, read-only set of
// statements, and pushes metrics and status like the agents do.
package integrations

// Config is what the backend serves at /ingest/v1/integrations/config.
type Config struct {
	Version string   `json:"version"`
	Scrape  Scrape   `json:"scrape"`
	Targets []Target `json:"targets"`
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
}

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

// SelfStatus is the collector's own footprint, for the budget (ADR-131).
type SelfStatus struct {
	RSSBytes   float64 `json:"rss_bytes,omitempty"`
	CPUSeconds float64 `json:"cpu_seconds,omitempty"`
	Series     int     `json:"series"`
}

// TargetStatus is one target's outcome.
type TargetStatus struct {
	ID             string         `json:"id"`
	State          string         `json:"state"` // ok, error, connecting
	Error          string         `json:"error,omitempty"`
	ServiceVersion string         `json:"service_version,omitempty"`
	Members        []MemberStatus `json:"members,omitempty"`
	Permissions    []Permission   `json:"permissions,omitempty"`
}

// MemberStatus says whether one member answered.
type MemberStatus struct {
	Name  string `json:"name"`
	Up    bool   `json:"up"`
	Error string `json:"error,omitempty"`
}

// Permission is a tab that can't be filled and the privilege or setting it needs (ADR-134).
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
