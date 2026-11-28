// SPDX-License-Identifier: AGPL-3.0-only

package mysql

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
	cases := []struct {
		state string
		lock  bool
		want  string
	}{
		{"executing", false, "cpu"},
		{"Sending data", false, "cpu"},
		{"updating", true, "lock"},
		{"Waiting for table metadata lock", false, "lock"},
		{"Sending to client", false, "client"},
		{"converting HEAP to ondisk", false, "io"},
		{"Waiting for handler commit", false, "other"},
		{"", false, "cpu"},
	}
	for _, c := range cases {
		if got := WaitClass(c.state, c.lock); got != c.want {
			t.Errorf("WaitClass(%q, %v) = %q, want %q", c.state, c.lock, got, c.want)
		}
	}
}

func TestStripLiterals(t *testing.T) {
	for in, want := range map[string]string{
		"UPDATE dl SET v=v+1 WHERE id=1":                        "UPDATE dl SET v=v+? WHERE id=?",
		"select * from t1 where name = 'O''Brien' and x = 0x1F": "select * from t1 where name = ? and x = ?",
		`INSERT INTO a VALUES ("x\"y", 3.5e2)`:                  "INSERT INTO a VALUES (?, ?)",
		"UPDATE users SET password = 'hunter2' WHERE id = 7":    "UPDATE users SET password = ? WHERE id = ?",
	} {
		if got := StripLiterals(in); got != want {
			t.Errorf("StripLiterals(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestParseDeadlock reads a real MySQL 8.4 report (Step 0): both statements without their
// literals, both clients, the victim; nothing from the record dumps.
func TestParseDeadlock(t *testing.T) {
	b, err := os.ReadFile("testdata/deadlock-mysql84.txt")
	if err != nil {
		t.Fatal(err)
	}
	d := ParseDeadlock(string(b), time.UTC)
	if d.At != time.Date(2026, 11, 28, 6, 41, 7, 0, time.UTC).Unix() {
		t.Errorf("at = %d", d.At)
	}
	if len(d.Txns) != 2 || d.Victim != 2 {
		t.Fatalf("txns = %d, victim = %d", len(d.Txns), d.Victim)
	}
	for i, want := range []string{"UPDATE dl SET v=v+? WHERE id=?", "UPDATE dl SET v=v+? WHERE id=?"} {
		if d.Txns[i]["query"] != want || d.Txns[i]["host"] != "localhost" || d.Txns[i]["user"] != "root" {
			t.Errorf("txn %d = %v", i, d.Txns[i])
		}
	}
	js, _ := json.Marshal(d)
	if strings.Contains(string(js), "PHYSICAL RECORD") || strings.Contains(string(js), "hex ") {
		t.Errorf("a record dump leaked: %s", js)
	}
	if ParseDeadlock("no deadlock here", time.UTC).At != 0 {
		t.Error("a deadlock out of nothing")
	}
}

// TestLabScrape scrapes the Step 0 servers (WATCHLOG_TEST_MY_LAB=host:port,… with the
// documented user watchlog / WATCHLOG_TEST_MY_LAB_PASSWORD) twice, heavy, and prints each
// series family and each extra.
func TestLabScrape(t *testing.T) {
	lab := os.Getenv("WATCHLOG_TEST_MY_LAB")
	if lab == "" {
		t.Skip("WATCHLOG_TEST_MY_LAB not set")
	}
	for _, addr := range strings.Split(lab, ",") {
		p := New()
		tg := integrations.Target{ID: "lab", Type: "mysql", Members: []integrations.Member{{Name: "m", Address: addr}},
			Auth:     &integrations.Auth{Username: "watchlog", Password: os.Getenv("WATCHLOG_TEST_MY_LAB_PASSWORD")},
			Settings: integrations.Settings{QueryText: true}}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		start := time.Now()
		_ = p.Scrape(ctx, tg, true)
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
		fmt.Printf("==== %s %s %s: %d samples, scrape %v then %v (catalog cached)\n", addr, r.Product, r.ServiceVersion, len(r.Samples), first.Round(time.Millisecond), second.Round(time.Millisecond))
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
