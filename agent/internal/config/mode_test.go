// SPDX-License-Identifier: AGPL-3.0-only

package config

import "testing"

func TestParseMode(t *testing.T) {
	tests := []struct {
		in      string
		want    Mode
		wantErr bool
	}{
		{"node", ModeNode, false},
		{"cluster", ModeCluster, false},
		{"docker", ModeDocker, false},
		{"", "", true},
		{"Node", "", true},
		{"swarm", "", true},
	}
	for _, tt := range tests {
		got, err := ParseMode(tt.in)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("ParseMode(%q) = %q, %v; want %q, wantErr %v", tt.in, got, err, tt.want, tt.wantErr)
		}
	}
}
