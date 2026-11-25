// SPDX-License-Identifier: AGPL-3.0-only

package ownmetrics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Timeout bounds one scrape (the brief's 10 seconds).
const Timeout = 10 * time.Second

// accept asks for OpenMetrics first, the text format otherwise (what Prometheus sends).
const accept = "application/openmetrics-text;version=1.0.0;q=0.9,text/plain;version=0.0.4;q=0.8,*/*;q=0.1"

var (
	errScheme   = errors.New("only http and https endpoints are scraped")
	errRedirect = errors.New("the endpoint redirects to another host; it is not followed")
	errTooBig   = fmt.Errorf("the answer is larger than %d MB", MaxBody>>20)
)

// NewClient is the scraper's HTTP client: no credentials, no cookies, and a redirect is
// followed only on the same host (never to another one, never from https to http).
func NewClient() *http.Client {
	return &http.Client{
		Timeout: Timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			first := via[0].URL
			if len(via) >= 5 || req.URL.Host != first.Host || (first.Scheme == "https" && req.URL.Scheme != "https") {
				return errRedirect
			}
			return nil
		},
	}
}

// Fetch scrapes one endpoint within the limits: http or https, 10 seconds, 5 MB.
func Fetch(ctx context.Context, client *http.Client, target string) (Scrape, error) {
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Scrape{}, errScheme
	}
	if u.User != nil {
		return Scrape{}, errors.New("an address with a user or password is not scraped")
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return Scrape{}, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "watchlog-integrations")
	res, err := client.Do(req)
	if err != nil {
		return Scrape{}, plain(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return Scrape{}, fmt.Errorf("the endpoint answered %d", res.StatusCode)
	}
	if res.ContentLength > MaxBody {
		return Scrape{}, errTooBig
	}
	// One byte past the limit tells an answer that is too big from one that just fits.
	body := &capped{r: io.LimitReader(res.Body, MaxBody+1)}
	out, err := Parse(body)
	if body.n > MaxBody {
		return Scrape{}, errTooBig
	}
	if err != nil {
		return out, plain(err)
	}
	return out, nil
}

type capped struct {
	r io.Reader
	n int64
}

func (c *capped) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// plain makes an error a short sentence for the sources table.
func plain(err error) error {
	switch {
	case errors.Is(err, errRedirect):
		return errRedirect
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Client.Timeout"):
		return fmt.Errorf("no answer within %d seconds", int(Timeout/time.Second))
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return errors.New(ue.Err.Error())
	}
	return err
}
