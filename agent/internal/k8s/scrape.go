// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"strconv"
	"strings"
)

// The annotations that say a pod's own metrics may be scraped (1.0.0, ADR-236). WatchLog's own
// always count; Prometheus's only where the cluster's setting says so, which the backend
// decides: the cluster-agent sends which kind it saw.
const (
	ScrapeAnnotation     = "watchlog.io/scrape"
	ScrapePortAnnotation = "watchlog.io/port"
	ScrapePathAnnotation = "watchlog.io/path"
	PromScrapeAnnotation = "prometheus.io/scrape"
	PromPortAnnotation   = "prometheus.io/port"
	PromPathAnnotation   = "prometheus.io/path"
)

const maxScrapePath = 256

// scrapeOf is a pod's scrape request from its annotations, nil without one: which annotation
// asked ("watchlog" wins over "prometheus"), the port (a number or a port's name; empty for the
// default, the first named port) and the path (empty for /metrics).
func scrapeOf(a map[string]string) map[string]any {
	source, port, path := "", "", ""
	switch {
	case a[ScrapeAnnotation] == "true":
		source, port, path = "watchlog", a[ScrapePortAnnotation], a[ScrapePathAnnotation]
	case a[PromScrapeAnnotation] == "true":
		source, port, path = "prometheus", a[PromPortAnnotation], a[PromPathAnnotation]
	default:
		return nil
	}
	out := map[string]any{"by": source}
	port = strings.TrimSpace(port)
	if n, err := strconv.Atoi(port); err == nil {
		if n < 1 || n > 65535 {
			return nil
		}
		out["port"] = n
	} else if port != "" && len(port) <= 63 {
		out["port_name"] = port
	}
	path = strings.TrimSpace(path)
	if path != "" && strings.HasPrefix(path, "/") && len(path) <= maxScrapePath {
		out["path"] = path
	}
	return out
}
