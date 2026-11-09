#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The eBPF kernel tests (agent/internal/ebpf, WATCHLOG_EBPF_TEST=1) in a Lima VM, in a
# container set up like the agent: uid 0, every capability dropped but BPF and PERFMON,
# read-only root filesystem, no privileged mode. They load the programs on the VM's
# kernel (the verifier and the hooks), then check flows, DNS and HTTP counts.
#   VM=watchlog-iso deploy/test/ebpf-test.sh [-test.run regexp]
#   WATCHLOG_DNS_TEST_NAME   a name that resolves from the VM, where example.com doesn't
#   WATCHLOG_EBPF_LOAD=1     also the 1,000 connections/s load test (sustained: 10 minutes)
# shellcheck disable=SC2016
set -euo pipefail
cd "$(dirname "$0")/../.."
vm=${VM:-watchlog-demo}
arch=$(limactl shell "$vm" uname -m)
case "$arch" in aarch64) goarch=arm64 ;; x86_64) goarch=amd64 ;; *) echo "unknown arch $arch" >&2; exit 1 ;; esac
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
(cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=$goarch go test -c -o "$out/ebpf.test" ./internal/ebpf)
echo "kernel: $(limactl shell "$vm" uname -r)"
# The binary is copied into the VM: a Lima mount may be read-only or unexported to Docker.
limactl copy "$out/ebpf.test" "$vm:/tmp/watchlog-ebpf.test"
# Arguments quoted for the VM's shell: a -run pattern may hold "|".
args=$(printf ' %q' "$@")
limactl shell "$vm" bash -c 'docker run --rm --user 0:0 --cap-drop ALL --cap-add BPF --cap-add PERFMON \
  --read-only --tmpfs /tmp --security-opt no-new-privileges -e WATCHLOG_EBPF_TEST=1 \
  -e WATCHLOG_DNS_TEST_NAME='"${WATCHLOG_DNS_TEST_NAME:-example.com}"' -e WATCHLOG_EBPF_LOAD='"${WATCHLOG_EBPF_LOAD:-}"' \
  -v /tmp/watchlog-ebpf.test:/ebpf.test:ro busybox:latest /ebpf.test -test.v -test.count=1'"$args"
