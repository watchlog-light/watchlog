// SPDX-License-Identifier: AGPL-3.0-only

package ebpf

// The objects and bindings are committed (ADR-100); regenerate with generate.sh.
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall -Werror" -target bpfel -type flow_key -type flow_val -type dns_val flows bpf/flows.bpf.c -- -I./bpf
