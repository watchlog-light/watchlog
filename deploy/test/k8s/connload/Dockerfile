# SPDX-License-Identifier: AGPL-3.0-only
# Test-only image, built locally and loaded into kind (never pushed, ADR-043).
FROM golang:1.27-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /connload .
FROM scratch
COPY --from=build /connload /connload
ENTRYPOINT ["/connload"]
