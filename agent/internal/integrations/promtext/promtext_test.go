// SPDX-License-Identifier: AGPL-3.0-only

package promtext

import (
	"math"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	in := `# HELP x_requests requests
# TYPE x_requests counter
x_requests{ingress="shop",status="503",path="/a\"b\\c"} 3
x_requests{ingress="shop",status="200",} 17 1700000000000
x_other 4
x_bucket{le="+Inf"} 9
x_gauge NaN
x_broken{a="b" 1
x_empty{} 2

`
	got, err := Parse(strings.NewReader(in), func(n string) bool { return strings.HasPrefix(n, "x_") && n != "x_other" })
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d samples: %+v", len(got), got)
	}
	if got[0].Labels["path"] != `/a"b\c` || got[0].Value != 3 || got[0].Labels["status"] != "503" {
		t.Errorf("escapes or value: %+v", got[0])
	}
	if got[1].Value != 17 || got[1].Labels["status"] != "200" {
		t.Errorf("trailing comma, timestamp: %+v", got[1])
	}
	if got[2].Labels["le"] != "+Inf" || got[2].Value != 9 {
		t.Errorf("bucket: %+v", got[2])
	}
	if got[3].Name != "x_empty" || got[3].Value != 2 || len(got[3].Labels) != 0 {
		t.Errorf("empty labels: %+v", got[3])
	}
	if v, _ := parseValue("+Inf"); !math.IsInf(v, 1) {
		t.Error("+Inf")
	}
}
