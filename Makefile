# WatchLog monorepo tasks. JS/TS tasks live in package.json (pnpm); Go and image tasks live here.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
VERSION_PKG := github.com/watchlog-light/watchlog/agent/internal/version
LDFLAGS := -s -w -X $(VERSION_PKG).Version=$(VERSION) -X $(VERSION_PKG).Commit=$(COMMIT)
IMAGE_PREFIX ?= ghcr.io/watchlog-light
IMAGE_TAG ?= dev
# Backend runtime base (ADR-014). Override when gcr.io is unreachable, e.g.
#   make images BACKEND_RUNTIME_IMAGE=node:24-bookworm-slim
# The agent image is built FROM scratch and needs no override (ADR-020).
BACKEND_RUNTIME_IMAGE ?= gcr.io/distroless/nodejs24-debian12:nonroot
# Go module proxy for the agent images; unset keeps Go's default. Where
# proxy.golang.org is blocked:  GOPROXY=https://goproxy.io,direct make images
GOPROXY_ARG := $(if $(GOPROXY),--build-arg GOPROXY='$(GOPROXY)')

.PHONY: agent agent-linux agent-test agent-lint bpf images image-agent image-cluster-agent image-backend image-web clean

## agent: build a static agent binary for this machine into bin/
agent:
	cd agent && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../bin/watchlog-agent ./cmd/watchlog-agent
	./bin/watchlog-agent --version

## agent-linux: cross-compile static linux/amd64 and linux/arm64 binaries
agent-linux:
	cd agent && for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" \
			-o ../bin/watchlog-agent-linux-$$arch ./cmd/watchlog-agent || exit 1; \
	done

agent-test:
	cd agent && go test -race ./...

agent-lint:
	cd agent && golangci-lint run ./...

## bpf: regenerate the eBPF objects and bindings in the pinned builder (needs Docker, ADR-100)
bpf:
	agent/internal/ebpf/generate.sh

## images: build (never push) the agent, cluster-agent, backend and web images
images: image-agent image-cluster-agent image-backend image-web

image-agent:
	docker build $(GOPROXY_ARG) --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) --target agent -t $(IMAGE_PREFIX)/agent:$(IMAGE_TAG) agent

image-cluster-agent:
	docker build $(GOPROXY_ARG) --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) --target cluster-agent -t $(IMAGE_PREFIX)/cluster-agent:$(IMAGE_TAG) agent

image-backend:
	docker build -f backend/Dockerfile --build-arg RUNTIME_IMAGE=$(BACKEND_RUNTIME_IMAGE) --build-arg VERSION=$(VERSION) -t $(IMAGE_PREFIX)/backend:$(IMAGE_TAG) .

image-web:
	docker build -f web/Dockerfile -t $(IMAGE_PREFIX)/web:$(IMAGE_TAG) .

clean:
	rm -rf bin
