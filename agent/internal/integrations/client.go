// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// LongPollWait is how long the backend may hold a config request open (ADR-131).
const LongPollWait = 25 * time.Second

// maxConfigBytes bounds the configuration read.
const maxConfigBytes = 8 << 20

// ErrUnauthorized means the token was refused.
var ErrUnauthorized = errors.New("the backend refused the token (401); check WATCHLOG_TOKEN")

// ConfigClient fetches the collector's configuration.
type ConfigClient struct {
	URL       string // .../ingest/v1/integrations/config
	Token     string
	Host      string // '' on Kubernetes
	AgentID   string
	UserAgent string
	Client    *http.Client
}

// Fetch returns the configuration, or nil when it is unchanged since etag. With wait
// set, the backend holds the request until the configuration changes or the wait ends.
func (c *ConfigClient) Fetch(ctx context.Context, etag string, wait time.Duration) (*Config, error) {
	q := url.Values{}
	if c.Host != "" {
		q.Set("host", c.Host)
	}
	if wait > 0 {
		q.Set("wait", strconv.Itoa(int(wait/time.Second)))
	}
	u := c.URL
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("User-Agent", c.UserAgent)
	req.Header.Set("X-WatchLog-Agent", c.AgentID)
	if etag != "" {
		req.Header.Set("If-None-Match", `"`+etag+`"`)
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: LongPollWait + 15*time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, redact(err, c.Token)
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusNotModified:
		return nil, nil
	case res.StatusCode == http.StatusUnauthorized:
		return nil, ErrUnauthorized
	case res.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("config request answered %d", res.StatusCode)
	}
	var cfg Config
	if err := json.NewDecoder(io.LimitReader(res.Body, maxConfigBytes)).Decode(&cfg); err != nil {
		return nil, fmt.Errorf("reading the configuration: %w", err)
	}
	if cfg.Version == "" {
		cfg.Version = strings.Trim(res.Header.Get("ETag"), `"`)
	}
	return &cfg, nil
}

// redact keeps the token out of errors that reach the log.
func redact(err error, token string) error {
	if token == "" || !strings.Contains(err.Error(), token) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), token, "<redacted>"))
}
