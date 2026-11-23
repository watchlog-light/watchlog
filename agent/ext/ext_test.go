// SPDX-License-Identifier: AGPL-3.0-only

package ext

import (
	"reflect"
	"testing"
)

func TestRegister(t *testing.T) {
	Register(Module{Name: "zeta", Feature: "network"})
	Register(Module{Name: "alpha", Feature: "network"})
	Register(Module{Name: "zeta", Feature: "other"})
	got := Names()
	if !reflect.DeepEqual(got, []string{"alpha", "zeta"}) {
		t.Fatalf("Names() = %v", got)
	}
	for _, m := range Modules() {
		if m.Name == "zeta" && m.Feature != "other" {
			t.Fatalf("the last registration wins: %+v", m)
		}
	}
}
