# SPDX-License-Identifier: AGPL-3.0-only
# Pinned toolchain for the eBPF objects (ADR-100): `make bpf` and CI run bpf2go here, so
# the committed objects are reproducible and normal builds need no clang.
FROM golang:1.27-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang-14 llvm-14 libbpf-dev \
 && ln -s /usr/bin/clang-14 /usr/local/bin/clang \
 && ln -s /usr/bin/llvm-strip-14 /usr/local/bin/llvm-strip \
 && rm -rf /var/lib/apt/lists/*
