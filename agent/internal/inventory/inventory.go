// SPDX-License-Identifier: AGPL-3.0-only

// Package inventory ships a server's certificates and scheduled jobs to the backend as one
// snapshot (ADR-224, `POST /ingest/v1/objects` with `source: "inventory"`): when it changed,
// checked every minute, and every 10 minutes regardless, so the backend's view is never older
// than that. A backend older than 0.10 refuses the payload (400): the agent then waits an hour
// before trying again, and everything else goes on (ADR-107).
package inventory

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Snapshot is what is sent; each part is filled by its collector.
type Snapshot struct {
	Source       string `json:"source"` // always "inventory"
	Node         string `json:"node"`
	Certificates any    `json:"certificates,omitempty"`
	CertCoverage any    `json:"certificateCoverage,omitempty"`
	Jobs         any    `json:"jobs,omitempty"`
	JobCoverage  any    `json:"jobCoverage,omitempty"`
}

// Shipper sends Build's snapshot.
type Shipper struct {
	Build func() Snapshot
	Send  func(ctx context.Context, body []byte) (sender.Outcome, int)
	Log   *slog.Logger
	// Check and Resend are how often a change is looked for and an unchanged snapshot is sent.
	Check, Resend, Refused time.Duration
	Now                    func() time.Time

	last     [32]byte
	lastSent time.Time
	waitTill time.Time
}

func (s *Shipper) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Tick sends the snapshot when it changed, or when the last send is older than Resend.
// It answers whether something was sent.
func (s *Shipper) Tick(ctx context.Context) bool {
	now := s.now()
	if now.Before(s.waitTill) {
		return false
	}
	snap := s.Build()
	snap.Source = "inventory"
	body, err := json.Marshal(snap)
	if err != nil {
		return false
	}
	sum := sha256.Sum256(body)
	resend := s.Resend
	if resend <= 0 {
		resend = 10 * time.Minute
	}
	if sum == s.last && now.Sub(s.lastSent) < resend {
		return false
	}
	out, status := s.Send(ctx, body)
	switch out {
	case sender.Delivered:
		s.last, s.lastSent = sum, now
		return true
	case sender.Rejected:
		refused := s.Refused
		if refused <= 0 {
			refused = time.Hour
		}
		s.waitTill = now.Add(refused)
		if s.Log != nil {
			s.Log.Info("the backend refused certificates and scheduled jobs; it may be older than 0.10. Trying again later", "status", status, "in", refused)
		}
	}
	return false
}

// Run ticks every Check until ctx ends.
func (s *Shipper) Run(ctx context.Context) {
	every := s.Check
	if every <= 0 {
		every = time.Minute
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		s.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
