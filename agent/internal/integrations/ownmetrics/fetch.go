// SPDX-License-Identifier: AGPL-3.0-only

package ownmetrics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
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
		return Scrape{}, &StatusError{Code: res.StatusCode}
	}
	if res.ContentLength > MaxBody {
		return Scrape{}, errTooBig
	}
	// One byte past the limit tells an answer that is too big from one that just fits.
	body := &capped{r: io.LimitReader(res.Body, MaxBody+1)}
	out, err := Parse(body)
	out.ContentType = res.Header.Get("Content-Type")
	if body.n > MaxBody {
		return Scrape{}, errTooBig
	}
	if err != nil {
		return out, plain(err)
	}
	return out, nil
}

// StatusError is an answer other than 200.
type StatusError struct{ Code int }

func (e *StatusError) Error() string { return fmt.Sprintf("the endpoint answered %d", e.Code) }

// Why says in one word why an address doesn't give metrics, for "Test" on the Add a source page
// (1.0.3): the page turns it into a sentence. detail carries what the word alone doesn't (a
// status code, the error's own text).
//
//	refused      nothing is listening on that port
//	no_host      the name doesn't resolve
//	slow         no answer within the scrape's 10 seconds
//	big          the answer is larger than the scrape's 5 MB
//	auth         401 or 403: it asks for credentials, which scraping can't send
//	status       another status than 200 (detail: the code)
//	html         it answered with a web page
//	not_metrics  it answered, but not in the Prometheus text format
//	redirect     it redirects to another host
//	tls          the TLS handshake failed (detail: why)
//	address      not an http or https address
//	other        anything else (detail: the error)
func Why(s Scrape, err error) (reason, detail string) {
	var se *StatusError
	var dns *net.DNSError
	switch {
	case err == nil && len(s.Series) > 0:
		return "", ""
	case errors.As(err, &se):
		if se.Code == http.StatusUnauthorized || se.Code == http.StatusForbidden {
			return "auth", strconv.Itoa(se.Code)
		}
		return "status", strconv.Itoa(se.Code)
	case errors.Is(err, errTooBig):
		return "big", ""
	case errors.Is(err, errRedirect):
		return "redirect", ""
	case errors.Is(err, errScheme):
		return "address", ""
	case err != nil && (errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "no answer within") || strings.Contains(err.Error(), "Client.Timeout")):
		return "slow", ""
	case err != nil && (errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(err.Error(), "connection refused")):
		return "refused", ""
	case errors.As(err, &dns) || (err != nil && strings.Contains(err.Error(), "no such host")):
		return "no_host", ""
	case err != nil && (strings.Contains(err.Error(), "tls:") || strings.Contains(err.Error(), "x509:")):
		return "tls", short(err.Error())
	}
	// It answered 200: a web page, something else that isn't metrics, or nothing at all.
	if strings.Contains(strings.ToLower(s.ContentType), "html") {
		return "html", ""
	}
	if err != nil && !isParse(err) {
		return "other", short(err.Error())
	}
	return "not_metrics", ""
}

// isParse says whether an error came from reading the text format (not from the network).
func isParse(err error) bool {
	var ne net.Error
	return !errors.As(err, &ne)
}

func short(s string) string {
	if len(s) > 200 {
		return s[:200]
	}
	return s
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
		return ue.Err // without the method and the address; still the error it was
	}
	return err
}
