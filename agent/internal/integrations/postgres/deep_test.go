// SPDX-License-Identifier: AGPL-3.0-only

package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/watchlog-light/watchlog/agent/internal/integrations"
)

func TestWaitClass(t *testing.T) {
	for in, want := range map[string]string{
		"": "cpu", "IO": "io", "Lock": "lock", "BufferPin": "lock", "Client": "client",
		"LWLock": "other", "IPC": "other", "Timeout": "other", "Activity": "other", "Extension": "other",
	} {
		if got := WaitClass(in); got != want {
			t.Errorf("WaitClass(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestCatalogCache: the catalog is read once per CatalogEvery and sent again in between.
func TestCatalogCache(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p := New()
	p.now = func() time.Time { return now }
	p.catalogs["t/m"] = &catalog{at: now.Add(-time.Minute), extra: map[string]any{"vacuum": []map[string]any{{"table": "a"}}},
		perms: map[string]string{"tables/sequences": "SELECT on the sequences"}}
	s := &scrape{extra: map[string]any{}, perms: map[string]string{}}
	// Within 10 minutes: no connection is needed (s.c is nil), the cache is sent.
	s.catalogOf(context.Background(), p, "t/m", integrations.Member{}, nil)
	if rows := asRows(s.extra["vacuum"]); len(rows) != 1 || rows[0]["table"] != "a" {
		t.Fatalf("cached extra not sent: %v", s.extra)
	}
	if s.perms["tables/sequences"] == "" {
		t.Fatal("cached permission not sent")
	}
}

// TestLabScrape scrapes the Step 0 servers (WATCHLOG_TEST_PG_LAB=host:port,host:port with
// the pg_monitor role watchlog / WATCHLOG_TEST_PG_LAB_PASSWORD) twice, heavy, and prints
// each series family and each extra: the proof of what a least-privilege role gets.
func TestLabScrape(t *testing.T) {
	lab := os.Getenv("WATCHLOG_TEST_PG_LAB")
	if lab == "" {
		t.Skip("WATCHLOG_TEST_PG_LAB not set")
	}
	for _, addr := range strings.Split(lab, ",") {
		p := New()
		tg := integrations.Target{ID: "lab", Type: "postgres", Members: []integrations.Member{{Name: "m", Address: addr}},
			Auth:     &integrations.Auth{Username: "watchlog", Password: os.Getenv("WATCHLOG_TEST_PG_LAB_PASSWORD")},
			Settings: integrations.Settings{QueryText: true}}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		start := time.Now()
		_ = p.Scrape(ctx, tg, true) // the first fills the top statements
		first := time.Since(start)
		start = time.Now()
		r := p.Scrape(ctx, tg, true)
		second := time.Since(start)
		cancel()
		if r.State != integrations.StateOK {
			t.Fatalf("%s: %s %s", addr, r.State, r.Error)
		}
		fams := map[string]int{}
		for _, smp := range r.Samples {
			fams[smp.Name]++
		}
		names := make([]string, 0, len(fams))
		for n := range fams {
			names = append(names, n)
		}
		sort.Strings(names)
		fmt.Printf("==== %s %s: %d samples, scrape %v then %v (catalog cached)\n", addr, r.ServiceVersion, len(r.Samples), first.Round(time.Millisecond), second.Round(time.Millisecond))
		for _, n := range names {
			fmt.Printf("  %-55s %d\n", n, fams[n])
		}
		keys := make([]string, 0, len(r.Extra))
		for k := range r.Extra {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b, _ := json.Marshal(r.Extra[k])
			if len(b) > 400 {
				b = append(b[:400], []byte("…")...)
			}
			fmt.Printf("  extra %-20s %s\n", k, b)
		}
		for _, perm := range r.Permissions {
			fmt.Printf("  missing %s: %s\n", perm.Tab, perm.Missing)
		}
	}
}
