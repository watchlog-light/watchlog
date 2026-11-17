// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"context"
	"testing"
)

func TestRemoteRules(t *testing.T) {
	calls := 0
	body := `{"rules":[{"exe":"python*","args":"-m (\\w+)","name":"py $1"},{"args":"(","name":"bad"},{"name":""}]}`
	r := &RemoteRules{Get: func(_ context.Context, etag string) (int, []byte, string, error) {
		calls++
		if etag == `"v1"` {
			return 304, nil, "", nil
		}
		return 200, []byte(body), `"v1"`, nil
	}}
	if err := r.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := r.Rules(); len(got) != 1 || got[0].Name != "py $1" {
		t.Fatalf("rules: %+v", got)
	}
	// The ETag comes back: nothing changes.
	if err := r.Refresh(context.Background()); err != nil || len(r.Rules()) != 1 || calls != 2 {
		t.Fatalf("304: %v %d", err, calls)
	}
	p := Proc{PID: 9, Comm: "python3", Args: []string{"/usr/bin/python3", "-m", "sync"}}
	if name, by := Name(p, "bash", "", r.Rules(), Hints{}); name != "py sync" || by != "rule" {
		t.Fatalf("%q %q", name, by)
	}
	// An older backend: no rules, no error.
	r2 := &RemoteRules{Get: func(context.Context, string) (int, []byte, string, error) { return 404, nil, "", nil }}
	if err := r2.Refresh(context.Background()); err != nil || r2.Rules() != nil {
		t.Fatal(err)
	}
}
