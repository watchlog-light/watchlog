// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"reflect"
	"testing"
)

func TestScrapeOf(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]string
		want map[string]any
	}{
		{"no annotation", map[string]string{"app": "x"}, nil},
		{"not true", map[string]string{ScrapeAnnotation: "false"}, nil},
		{"defaults", map[string]string{ScrapeAnnotation: "true"}, map[string]any{"by": "watchlog"}},
		{"port and path", map[string]string{ScrapeAnnotation: "true", ScrapePortAnnotation: "8080", ScrapePathAnnotation: "/internal/metrics"},
			map[string]any{"by": "watchlog", "port": 8080, "path": "/internal/metrics"}},
		{"a named port", map[string]string{ScrapeAnnotation: "true", ScrapePortAnnotation: "http-metrics"},
			map[string]any{"by": "watchlog", "port_name": "http-metrics"}},
		{"prometheus", map[string]string{PromScrapeAnnotation: "true", PromPortAnnotation: "9102"},
			map[string]any{"by": "prometheus", "port": 9102}},
		{"watchlog wins", map[string]string{ScrapeAnnotation: "true", PromScrapeAnnotation: "true", PromPortAnnotation: "1"},
			map[string]any{"by": "watchlog"}},
		{"a port out of range", map[string]string{ScrapeAnnotation: "true", ScrapePortAnnotation: "70000"}, nil},
		{"a path that isn't one", map[string]string{ScrapeAnnotation: "true", ScrapePathAnnotation: "metrics"},
			map[string]any{"by": "watchlog"}},
	}
	for _, c := range cases {
		if got := scrapeOf(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestScrapeAnnotationsSurviveTheAllowList(t *testing.T) {
	for _, k := range []string{ScrapeAnnotation, ScrapePortAnnotation, ScrapePathAnnotation, PromScrapeAnnotation, PromPortAnnotation, PromPathAnnotation} {
		if !keepAnnotations[k] {
			t.Errorf("%s is dropped by the annotation allow-list", k)
		}
	}
}
