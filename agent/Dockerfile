# SPDX-License-Identifier: AGPL-3.0-only
# Build context: agent/
# Runtime images are `scratch` (ADR-020): static binary, CA certificates and a
# nonroot passwd entry only, so no base image needs to be pulled at runtime.
# Two images from one build (ADR-048): `--target cluster-agent` for the
# cluster-agent; the default (last) target is the node/Docker agent.
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
WORKDIR /src
COPY go.mod go.sum ./
# Module proxy; unset keeps Go's default. Where proxy.golang.org is blocked:
#   --build-arg GOPROXY=https://goproxy.io,direct
ARG GOPROXY
RUN go mod download
COPY . .
RUN for cmd in watchlog-agent watchlog-cluster-agent; do \
      CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags "-s -w -X github.com/watchlog-light/watchlog/agent/internal/version.Version=${VERSION} -X github.com/watchlog-light/watchlog/agent/internal/version.Commit=${COMMIT}" \
      -o /out/$cmd ./cmd/$cmd || exit 1; \
    done \
 && echo 'nonroot:x:65532:65532:nonroot:/nonexistent:/sbin/nologin' > /out/passwd \
 && echo 'nonroot:x:65532:' > /out/group \
 && mkdir -p /out/data/buffer && chmod -R 0770 /out/data

FROM scratch AS cluster-agent
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/passwd /etc/passwd
COPY --from=build /out/group /etc/group
COPY --from=build /out/watchlog-cluster-agent /usr/local/bin/watchlog-cluster-agent
COPY --from=build --chown=65532:65532 /out/data /var/lib/watchlog-agent
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/watchlog-cluster-agent"]

FROM scratch AS agent
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/passwd /etc/passwd
COPY --from=build /out/group /etc/group
COPY --from=build /out/watchlog-agent /usr/local/bin/watchlog-agent
# Owned by the agent user so a fresh named volume mounted here is writable (ADR-022).
COPY --from=build --chown=65532:65532 /out/data /var/lib/watchlog-agent
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/watchlog-agent"]
