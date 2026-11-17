// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// MaxRules is the most user rules a fleet has (the backend enforces it too).
const MaxRules = 50

// RemoteRules holds a fleet's process-group rules (ADR-207's process-rules), fetched from
// the backend every minute; a rule that doesn't compile is skipped and logged once.
type RemoteRules struct {
	// Get fetches the rules document (status, body, ETag); the sender's Get.
	Get func(ctx context.Context, etag string) (int, []byte, string, error)
	Log *slog.Logger

	mu    sync.RWMutex
	rules []Rule
	etag  string
}

// Rules are the current rules, compiled: the collector's Rules.
func (r *RemoteRules) Rules() []Rule {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.rules
}

// Refresh fetches the rules once; the old rules stay on any error.
func (r *RemoteRules) Refresh(ctx context.Context) error {
	r.mu.RLock()
	etag := r.etag
	r.mu.RUnlock()
	status, body, newTag, err := r.Get(ctx, etag)
	if err != nil {
		return err
	}
	switch status {
	case http.StatusNotModified:
		return nil
	case http.StatusNotFound:
		// An older backend without process-rules: no user rules.
		return nil
	case http.StatusOK:
	default:
		return &statusError{status}
	}
	var doc struct {
		Rules []Rule `json:"rules"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return err
	}
	if len(doc.Rules) > MaxRules {
		doc.Rules = doc.Rules[:MaxRules]
	}
	rules := make([]Rule, 0, len(doc.Rules))
	for _, rule := range doc.Rules {
		if rule.Name == "" {
			continue
		}
		if err := rule.Compile(); err != nil {
			if r.Log != nil {
				r.Log.Warn("a process-group rule doesn't compile: skipped", "name", rule.Name, "err", err)
			}
			continue
		}
		rules = append(rules, rule)
	}
	r.mu.Lock()
	r.rules, r.etag = rules, newTag
	r.mu.Unlock()
	return nil
}

// Run refreshes the rules every interval until ctx ends.
func (r *RemoteRules) Run(ctx context.Context, interval time.Duration) {
	for {
		if err := r.Refresh(ctx); err != nil && r.Log != nil && ctx.Err() == nil {
			r.Log.Debug("process-group rules not fetched", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

type statusError struct{ status int }

func (e *statusError) Error() string { return "process rules: HTTP " + http.StatusText(e.status) }
