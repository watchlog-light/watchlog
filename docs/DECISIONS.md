# Architecture decisions

ADR-lite records (format: SPEC §15.1). Claude Code writes them when a decision is made; the maintainer approves.
Status values: `proposed`, `accepted`, `superseded by ADR-NNN`.

## ADR-001: Node.js 24 LTS instead of Node.js 22

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §5.1 and §12 name Node.js 22 LTS. Node 22 is in maintenance LTS and reaches end of life on 30 April 2027, which is likely before or shortly after the v2 launch.
- Decision: The backend, workers, web build and site build target **Node.js 24 LTS** (supported until April 2028). SPEC.md is updated in a separate `docs:` commit.
- Alternatives: Node 22 (rejected: EOL within six months); Node 26 (rejected: not yet LTS at decision time).
- Consequences: The backend image uses `distroless/nodejs24`. Node 26 will become LTS later; we upgrade within one LTS cycle.

## ADR-002: Version pinning via .nvmrc, engines and corepack

- Date: 2026-10-31 · Status: accepted
- Context: Contributors need the same Node and pnpm versions without installing a specific version manager.
- Decision: `.nvmrc` pins the Node major version, `engines` in the root `package.json` enforces it, and the `packageManager` field pins pnpm, which is activated with `corepack enable`.
- Alternatives: mise/asdf (rejected: an extra tool for every contributor); Volta (rejected: same, and it is less active).
- Consequences: nvm, fnm, mise and volta all read `.nvmrc`. CI uses `actions/setup-node` with `node-version-file: .nvmrc`.

## ADR-003: Go 1.27 pinned in go.mod

- Date: 2026-10-31 · Status: accepted
- Context: The agent needs a reproducible Go toolchain (SPEC §6).
- Decision: Use **Go 1.27**. `agent/go.mod` declares `go 1.27`, and a `toolchain` line pins the exact patch version, so any newer local Go downloads the pinned toolchain automatically.
- Alternatives: Go 1.26 (rejected: older, no benefit).
- Consequences: Bump the version deliberately, usually once per Go release.

## ADR-004: Kysely as query builder, types generated from the live database

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §13 Phase 0 asks for a choice between Drizzle and Kysely. The data model (§7) uses Row-Level Security, day-partitioned `k8s_events` and jsonb columns.
- Decision: Use **Kysely** for queries and **kysely-codegen** to generate TypeScript table types from a migrated database.
- Alternatives: Drizzle (rejected: its schema-first diffing handles partitioned tables and RLS policies poorly, and it hides SQL); raw `pg` (rejected: no type safety).
- Consequences: The schema lives in SQL migrations, not in TS. The generated types are committed and regenerated after every migration ("measure before change": types come from the real DB).

## ADR-005: node-pg-migrate with plain SQL, forward-only

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §7 asks for forward-only migrations with one file per change.
- Decision: Use **node-pg-migrate**, with migrations written as `.sql` files in `backend/migrations/`. There are no down migrations.
- Alternatives: Drizzle Kit (rejected together with Drizzle); Kysely's built-in Migrator (rejected: TS-only migrations and a weaker CLI).
- Consequences: Partitions and RLS are written directly in SQL. The `backend migrate` one-shot container (SPEC §5.5) wraps the node-pg-migrate CLI. Fixing a bad migration means writing a new migration.

## ADR-006: Vitest for TypeScript, Go's built-in testing for the agent

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §14 names Vitest. The agent needs fixture-based tests.
- Decision: Use **Vitest** for backend, web and packages; web component tests use `@vue/test-utils` with `happy-dom`. The agent uses the **built-in Go `testing` package**, plus benchmarks for collectors.
- Alternatives: Jest (rejected: slower, weaker ESM support); testify (rejected: not needed yet).
- Consequences: Playwright (SPEC §14) is added when the first critical flow exists (Phase 5).

## ADR-007: ESLint 9 + typescript-eslint + eslint-plugin-vue, Prettier

- Date: 2026-10-31 · Status: accepted
- Context: The TS/Vue packages need linting and formatting.
- Decision: One root ESLint flat config (`eslint.config.js`) using typescript-eslint and eslint-plugin-vue, with **Prettier** for formatting (`eslint-config-prettier` turns off overlapping rules).
- Alternatives: Biome (rejected: Vue single-file component support is less mature).
- Consequences: Two tools instead of one; `pnpm lint` and `pnpm format:check` run in CI.

## ADR-008: golangci-lint v2 and govulncheck for Go

- Date: 2026-10-31 · Status: accepted
- Context: The Go agent needs linting, formatting and vulnerability checks (SPEC §14).
- Decision: Use **golangci-lint v2** (formatters gofmt and goimports; linters govet, staticcheck, errcheck, gosec, ineffassign, unused), configured in `agent/.golangci.yml`, plus **govulncheck** in CI.
- Alternatives: Plain `go vet` + `staticcheck` (rejected: more scripts, fewer checks).
- Consequences: The golangci-lint version is pinned in CI so its results stay reproducible.

## ADR-009: Fastify 5 with TypeBox, swagger and helmet; other plugins added when needed

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §8 requires OpenAPI 3.1 generated from Fastify schemas and RFC 9457 errors.
- Decision: Use **Fastify 5** with `@fastify/type-provider-typebox`, `@fastify/swagger` (served at `/api/v1/openapi.json`) and `@fastify/helmet`. The RFC 9457 error handler is our own code. `@fastify/cookie`, `@fastify/csrf-protection`, `@fastify/rate-limit`, `@fastify/under-pressure` and `@fastify/cors` are added in the phase whose feature needs them. Development runs `tsx watch`; builds use `tsc`.
- Alternatives: Zod type provider (rejected: Zod schemas must be converted to JSON Schema, while TypeBox schemas already are JSON Schema); a heavier framework such as NestJS (rejected: too much framework for one developer).
- Consequences: One schema gives validation, TS types and OpenAPI, and the OpenAPI output feeds `packages/api-types`.

## ADR-010: Web stack additions

- Date: 2026-10-31 · Status: accepted
- Context: The SPA needs routing, i18n, icons and fonts that also work in air-gapped installs.
- Decision: Use **Vue Router 4**, **vue-i18n** (`web/src/i18n/en.json`), **Tailwind v4** via `@tailwindcss/vite`, **lucide-vue-next** icons, and fonts self-hosted via `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`.
- Alternatives: Google Fonts CDN (rejected: privacy and air-gapped Enterprise); a UI kit (rejected by SPEC §11.3).
- Consequences: Fonts ship in the bundle (~100 KB woff2). Icons are tree-shaken. Note: the icon package was renamed upstream from `lucide-vue-next` to `@lucide/vue`; we use `@lucide/vue`.

## ADR-011: Design tokens as CSS variables, a Tailwind v4 @theme file instead of a JS preset

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §11.4 describes a Tailwind preset. Tailwind v4 is configured in CSS (`@theme`) and has no JS presets.
- Decision: `packages/design-tokens/tokens.css` defines exactly the SPEC §11.1 colour tokens on `:root`, plus the §11.1 chart palette as `--chart-1` … `--chart-8`. `packages/design-tokens/theme.css` is the "preset": an `@theme` block that maps Tailwind colours to `var(--token)` and sets fonts, radii and the type scale. Both `web/` and `site/` import both files.
- Alternatives: Tailwind v3 with a JS preset (rejected: v3 is legacy); duplicating the config per app (rejected: drift).
- Consequences: A light theme is a second `tokens.css` block, with no component changes. Hex values exist only in `tokens.css`.

## ADR-012: Nuxt 4 for the marketing site

- Date: 2026-10-31 · Status: accepted
- Context: The SPEC originally named Nuxt 3, which reached end of life on 31 July 2026.
- Decision: `site/` uses **Nuxt 4** with static generation. The maintainer updated SPEC §5.1, §9 and §12.
- Alternatives: Nuxt 3 (rejected: no security fixes).
- Consequences: None for Phase 0 (placeholder page only).

## ADR-013: compose.dev.yaml runs infrastructure only; apps run on the host

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §13 Phase 0 lists the backend and web inside `compose.dev.yaml`. The kick-off instructions ask for compose to run the infrastructure, and for `pnpm dev` to run the backend and web.
- Decision: `deploy/docker/compose.dev.yaml` runs **PostgreSQL 16, VictoriaMetrics and Redis 7** with healthchecks and named volumes. Root `pnpm dev` runs the backend (`tsx watch`) and web (Vite) on the host, using `pnpm --parallel` (no Turborepo).
- Alternatives: Apps inside compose with bind mounts (rejected: slow file watching on macOS, more moving parts).
- Consequences: Developers need Node locally (already required). Production images are covered by the Dockerfiles and CI.

## ADR-014: Container images on GHCR, distroless bases, build-only for now

- Date: 2026-10-31 · Status: accepted
- Context: CI must build images for `agent`, `backend` and `web` (SPEC §13). SPEC §5.5 deploys from GHCR.
- Decision: Images are `ghcr.io/watchlog-light/{agent,backend,web}`. Bases: agent `gcr.io/distroless/static-debian12:nonroot`; backend `gcr.io/distroless/nodejs24-debian12:nonroot`; web `caddy` serving the static build. The agent builds for `linux/amd64` and `linux/arm64` (cheap Go cross-compile); backend and web build for amd64 only until we push. Nothing is pushed yet.
- Alternatives: Docker Hub (rejected: rate limits, a separate account); Alpine bases (rejected: larger attack surface than distroless).
- Consequences: Distroless images have no shell, so debugging uses `kubectl debug` or ephemeral containers. Pushing and cosign signing are enabled in a later phase.

## ADR-015: AGPL-3.0-only with SPDX headers

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §3.4 requires AGPL-3.0 outside `ee/` and a commercial license inside it, and the boundary must be auditable.
- Decision: The root `LICENSE` is **AGPL-3.0-only**. Every Go, TS and Vue source file starts with `SPDX-License-Identifier: AGPL-3.0-only`; files under `ee/` use `LicenseRef-WatchLog-Enterprise`. `scripts/check-license-headers.sh` enforces this in CI.
- Alternatives: AGPL-3.0-or-later (rejected: hands license upgrades to the FSF; the CLA keeps relicensing in our control); full boilerplate headers (rejected: noise).
- Consequences: Generated files (e.g. bpf2go output) are excluded by path in the check script.

## ADR-016: Agent module path and Phase 0 dependencies

- Date: 2026-10-31 · Status: accepted
- Context: The Go module path depends on the GitHub organisation (ADR-017).
- Decision: The module path is `github.com/watchlog-light/watchlog/agent`. Phase 0 uses only the standard library (`flag`, `log/slog`). The version is set at link time via `-ldflags -X` from `git describe`. `make agent` builds a static binary (`CGO_ENABLED=0`) into `bin/`.
- Alternatives: cobra/viper (rejected: dependency weight for three flags).
- Consequences: More dependencies (cilium/ebpf, client-go) arrive with their phases.

## ADR-017: GitHub organisation `watchlog-light` (answers SPEC §16 open question #4)

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §12 assumed `watchlog/watchlog`, but the `watchlog` organisation may be taken.
- Decision: The repository is **github.com/watchlog-light/watchlog**, created **private** for now. The container registry is **GHCR** under the same organisation: `ghcr.io/watchlog-light/{agent,backend,web}`.
- Alternatives: none evaluated; the owner chose the name.
- Consequences: The SPEC references to `watchlog/watchlog` and `ghcr.io/watchlog/agent` (§6.7, §12) need updating in a later `docs:` change. The Helm chart name `watchlog/watchlog` (a Helm repo alias, not the GitHub org) is unaffected.

## ADR-018: CI workflows are manual-only until approved

- Date: 2026-10-31 · Status: accepted
- Context: The owner wants Phase 0 verified locally before CI runs on GitHub.
- Decision: All GitHub Actions workflows use the `workflow_dispatch` trigger only (no `push` or `pull_request`). No workflow pushes images.
- Alternatives: none.
- Consequences: "CI green on GitHub" is deferred in the phase 0 checklist (private notes). Enabling push and PR triggers will be its own `ci:` commit once the owner approves.

## ADR-019: Toolchain version pins for Phase 0 (TypeScript 6.0, ESLint 10)

- Date: 2026-10-31 · Status: accepted (follows from ADR-006/007; owner to confirm)
- Context: At install time, `typescript@latest` is 7.0 (the native compiler), but typescript-eslint supports only `typescript <6.1`. ESLint 10 is current, while ADR-007 named ESLint 9.
- Decision: Pin **TypeScript ~6.0** across the workspace and use **ESLint 10** (flat config, same plugins as ADR-007). The other majors are taken as current: Vite 8, Vitest 5, Vue Router 5, Pinia 4, Tailwind 4.3, pnpm 12.
- Alternatives: TypeScript 7 (rejected: breaks typescript-eslint and the vue-tsc type-aware tooling); ESLint 9 (rejected: no reason to start on the previous major).
- Consequences: Move to TypeScript 7 once typescript-eslint supports it; that will be its own `chore:` commit.

## ADR-020: Agent image built FROM scratch (amends ADR-014)

- Date: 2026-10-31 · Status: accepted
- Context: gcr.io (and mirror.gcr.io, cgr.dev) return HTTP 403 from the owner's network, most likely due to sanctions-based blocking, so the distroless agent image from ADR-014 can never be built or verified locally. SPEC §6.1 requires the agent image to be ≤ 40 MB.
- Decision: The agent's runtime stage is **`FROM scratch`**, containing only the static binary, `/etc/ssl/certs/ca-certificates.crt` and `/etc/passwd`/`/etc/group` entries for `nonroot` (uid/gid 65532), all copied from the Go builder stage. It runs as `65532:65532`. Backend and web keep the ADR-014 bases (distroless Node.js 24, Caddy) with the `RUNTIME_IMAGE` build-arg fallback for local builds; those are verified on GitHub CI.
- Alternatives: distroless static (rejected: cannot be pulled locally); Debian slim (rejected: ~75 MB and a larger attack surface).
- Consequences: The image is ~2.9 MB (linux/amd64 and linux/arm64) and has no shell or tzdata; timestamps are in UTC. Debugging uses ephemeral containers. CA certificates are refreshed whenever the builder image is updated.

## ADR-021: Own minimal remote_write 1.0 encoder in the agent

- Date: 2026-10-31 · Status: accepted
- Context: The agent pushes metrics with Prometheus remote_write (protobuf + snappy, SPEC §5.2) and must stay within 64 MB RSS (SPEC §6.1).
- Decision: Implement the three Remote-Write 1.0 messages (`WriteRequest`, `TimeSeries`, `Label`/`Sample`) with `google.golang.org/protobuf/encoding/protowire` and block-format snappy from `github.com/klauspost/compress/snappy`. Golden-bytes fixtures produced by the Go tests are also used by the backend decoder tests, and a round-trip test writes to a real VictoriaMetrics.
- Alternatives: `github.com/prometheus/prometheus/prompb` (rejected: pulls the Prometheus module and hundreds of transitive dependencies); Remote-Write 2.0 (rejected: VictoriaMetrics and the SPEC target 1.0).
- Consequences: ~200 lines we own and must test thoroughly (including fuzzing).

## ADR-022: Agent on-disk buffer: one file per batch, drop poison batches

- Date: 2026-10-31 · Status: accepted
- Context: Agents buffer up to 15 minutes / 200 MB when the backend is unreachable (SPEC §5.2), and "killing the backend for 5 minutes loses no data" (SPEC §13).
- Decision: Each outgoing batch is stored as one file containing the exact snappy-compressed request body, written to a temp file and renamed into `/var/lib/watchlog-agent/buffer/` (named by timestamp + sequence). Replay sends the oldest first, paced at ≤ 1 request/s. When the buffer exceeds 200 MB or a file is older than 15 minutes, the oldest files are deleted and counted in `watchlog_agent_batches_dropped_total{reason="buffer_full"|"expired"}`. Response handling:
  - **Retry** (keep the file, exponential back-off 1 s → 60 s with jitter): network errors, 408, 429 (honouring `Retry-After`), 5xx.
  - **401**: back off 5 minutes, log a clear message, keep buffering.
  - **Any other 4xx** (including 400, 402, 413, 422): drop the batch, log it, count it in `watchlog_agent_batches_dropped_total{reason="rejected",code="<status>"}`. A poison batch must never block the queue.
- Alternatives: a write-ahead log with record framing (rejected: more code, same guarantees for our batch sizes); in-memory only (rejected: loses data on restart).
- Consequences: Docker mode needs a writable named volume for the buffer directory. Every response class above gets its own test.

## ADR-023: Docker-mode agent privileges

- Date: 2026-10-31 · Status: accepted
- Context: Measured on Docker Desktop: `/var/run/docker.sock` is `root:root 660`; host `/proc/1/root` is not readable by a non-root user, so `statfs` on host filesystems needs a read-only root mount. Docker Desktop does not expose the real host `/proc` or cgroups at all, so the final mount list is measured on a real Linux VM in slice 3.
- Decision: The agent runs as uid 65532 with no added capabilities (no `BPF`/`PERFMON` before Phase 4), `--pid host`, and read-only mounts: `/var/run/docker.sock`, `/proc` → `/host/proc`, `/sys` → `/host/sys`, `/` → `/host/root` (`ro,rslave`, used only for `statfs`), plus a named volume for the buffer. Socket access comes from a supplementary group that the install command computes itself: `--group-add "$(stat -c %g /var/run/docker.sock)"`, so users never look up a gid.
- Alternatives: running as root (rejected: least privilege); `--privileged` (rejected).
- Consequences: Any mount that slice 3 measurements show is unnecessary is removed. docs/security.md lists every mount and why.

## ADR-024: Docker API access through an allowlisted minimal client

- Date: 2026-10-31 · Status: accepted
- Context: The Docker socket must be read-only and limited to list/inspect/stats/events (Phase 1 rules). The hosts list needs the Docker and kernel versions (SPEC §4.4).
- Decision: Our own HTTP-over-unix-socket client (no moby SDK) with a hard-coded allowlist of GET requests: `/_ping`, `/version`, `/containers/json`, `/containers/{id}/json`, `/containers/{id}/stats?stream=false&one-shot=true`, `/events`. Any other method or path fails in the client before a request is made, and a test asserts this. `/info` is excluded because it returns proxy settings that can contain credentials.
- Alternatives: `github.com/docker/docker/client` (rejected: large dependency tree, no allowlist).
- Consequences: Response structs are written from real captured responses (fixtures), not from API docs.

## ADR-025: Cluster tokens hashed with SHA-256, not argon2id (amends SPEC §6.6)

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §6.6 said cluster tokens are stored with argon2id. Agents authenticate every ~15 s per node; argon2id costs tens of milliseconds and ~19 MiB per verification, which does not scale to SPEC §14's 2,000 nodes.
- Decision: Tokens are `wl_ct_` + base64url of 32 random bytes (256 bits). The backend stores SHA-256(token) and `prefix` (the first 8 characters after `wl_ct_`, unique, shown in the UI). Verification: look up by prefix, constant-time compare of the hash, then cache `hash → cluster` in memory for 60 s (revocation is immediate on the instance that revokes and within 60 s elsewhere). The same scheme is used for personal API tokens (`wl_pat_`, P1) and session IDs. Passwords keep argon2id.
- Alternatives: argon2id with a cache (rejected: cost without security benefit; a cache keyed by plaintext tokens holds secrets in memory anyway).
- Consequences: Security rests on token entropy, which the backend controls. SPEC §6.6 updated.

## ADR-026: Ingest gateway validates, then forwards the original body with extra_label

- Date: 2026-10-31 · Status: accepted
- Context: `cluster_id` must be injected server-side and never trusted from the agent (SPEC §5.2). Measured: VictoriaMetrics `/api/v1/write?extra_label=cluster_id=X` overrides any `cluster_id` label in the payload.
- Decision: The backend snappy-decodes and parses the protobuf only to validate it and count series; requests that contain the reserved labels `cluster_id` or `tenant_id` are rejected with 400. The original body is forwarded unchanged with `extra_label=cluster_id=<id>`. Snappy uses the `snappy` npm package (napi-rs prebuilt binaries); protobuf parsing is a small decoder of our own tested with the agent's golden fixtures. CI proves both native modules (`snappy`, `@node-rs/argon2`) load in the distroless backend image on amd64 and in an arm64 build; if either fails, we switch to a pure-JS/WASM alternative and record it here.
- Alternatives: decode, rewrite and re-encode in Node (rejected: CPU and complexity); forward without decoding (rejected: no validation or series limits).
- Consequences: Two independent protections against label spoofing.

## ADR-027: Ingest limits for Phase 1

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §8.2 defines 413/429/402; SPEC §14 targets up to 500 nodes per cluster. Each node sends 1 write + 1 heartbeat per 15 s (≈ 0.13 req/s), so 500 nodes ≈ 66 req/s.
- Decision:
  - 413 if the compressed body is > 4 MiB, the snappy-declared decoded length is > 32 MiB (checked before decompressing), or a request has > 20,000 series.
  - 429 with `Retry-After` from in-memory token buckets: **per agent instance** (cluster token + `X-WatchLog-Agent` host header): 1 req/s sustained, burst 20; **per cluster ceiling**: 250 req/s sustained, burst 500 (≈ 3.75× the steady load of 500 nodes, leaving room for replay after an outage). The host header is only a rate-limit key; spoofing it cannot exceed the cluster ceiling.
  - 401 for missing, unknown or revoked tokens (agent backs off 5 minutes).
  - 402 is not used in Phase 1 (Community has no plan limits; Phase 5).
  - The agent enforces the 20,000 active series per node cap (SPEC §6.3) and paces replay at ≤ 1 req/s, which fits under the per-instance bucket.
- Alternatives: per-cluster-only limits (rejected: 20 req/s breaks 500-node clusters); Redis-backed buckets (rejected: Redis is optional in Community).
- Consequences: Limits are per backend process; with several backend replicas (Cloud scale-out) they are per replica until moved to Redis.

## ADR-028: Curated query API with enforced cluster filter

- Date: 2026-10-31 · Status: accepted
- Context: `POST /query/range` takes `{metric, scope, agg, step, from, to}` (SPEC §8.1); users must never read another cluster's data. Measured: VictoriaMetrics' `extra_label=cluster_id=X` query argument is applied to every selector; `or`, regex matchers, `label_replace` and `sum()` could not escape it.
- Decision: `metric` is a key into a server-side catalog; each entry holds a MetricsQL template, unit and allowed scopes/aggregations. `scope` is a typed object rendered only as escaped label matchers. `agg` is an enum. `step` is clamped to ≥ 15 s and ≤ ~1,000 points. The cluster comes from the URL and is authorised against the user's org in PostgreSQL. Every VictoriaMetrics query goes through one client function that requires the authorised cluster and always adds `extra_label=cluster_id=<id>`. No raw MetricsQL in Phase 1.
- Alternatives: client-side MetricsQL (rejected: SPEC forbids raw queries before P1 advanced mode).
- Consequences: New charts need a catalog entry; the catalog is unit-tested per metric.

## ADR-029: Schema additions for Phase 1 (amends SPEC §7)

- Date: 2026-10-31 · Status: accepted
- Context: Phase 1 needs sessions, per-host agent status and Docker inventory, which SPEC §7 did not list.
- Decision: Add `sessions` (user_id, token_hash, expires_at, last_seen_at) and `agent_instances` (cluster_id, node, mode, agent_version, capabilities jsonb, last_seen_at). Rename `k8s_objects` to `objects` with a `source` column (`kubernetes`/`docker`) so Docker hosts and containers use the same inventory table as Kubernetes objects. Docker events only update counters and inventory in Phase 1; the events table and timeline arrive with Kubernetes events in Phase 2. Containers are labelled by name, never by ID.
- Alternatives: separate `docker_*` tables (rejected: duplicate upsert logic and APIs).
- Consequences: SPEC §7 updated. Tables are created in the slice that first uses them.

## ADR-030: UUID v7 generated in the application

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §7 requires UUID v7 ids; PostgreSQL 16 has no built-in `uuidv7()`.
- Decision: The backend generates ids with the `uuid` package (`v7()`); columns are `uuid` without a database default.
- Alternatives: a PL/pgSQL `uuidv7()` function (rejected: slower and one more thing to migrate when moving to PostgreSQL 18's native function).
- Consequences: Rows can only be inserted through the backend (or by passing ids explicitly).

## ADR-031: Backend tests run against real PostgreSQL and VictoriaMetrics

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §14 requires integration tests against real databases.
- Decision: Vitest's global setup recreates a `watchlog_test` database and runs all migrations. Locally it uses the compose.dev PostgreSQL; in CI a `postgres:16-alpine` service container. VictoriaMetrics joins the same way in the ingest and query slices.
- Alternatives: mocks or pg-mem (rejected: they hide real SQL behaviour).
- Consequences: `pnpm test` needs `pnpm infra:up` locally; the test setup prints a clear message when PostgreSQL is unreachable.

## ADR-032: First-run setup with a one-time code, or env bootstrap

- Date: 2026-10-31 · Status: accepted
- Context: Community mode has a single admin and no signup (SPEC §13 Phase 1). A fresh instance must not be claimable by whoever reaches it first.
- Decision: While no user exists, the backend generates a one-time setup code at startup and prints it in its log; the web setup screen requires that code to create the admin. Alternatively, `WATCHLOG_ADMIN_EMAIL` and `WATCHLOG_ADMIN_PASSWORD` create the admin at startup (headless installs).
- Alternatives: open setup screen (rejected: takeover risk); env vars only (rejected: worse first-run experience).
- Consequences: The code changes on every restart until setup is done.

## ADR-033: Server-side sessions in PostgreSQL

- Date: 2026-10-31 · Status: accepted
- Context: The web app uses an HTTP-only session cookie (SPEC §8). Redis is optional in Community (SPEC §5.1).
- Decision: A 256-bit random session id in cookie `wl_session` (HttpOnly, SameSite=Lax, Path=/; `Secure` whenever the request arrives over HTTPS, honouring `X-Forwarded-Proto` when the proxy is trusted). PostgreSQL stores SHA-256 of the id (ADR-025) with a 30-day sliding expiry (refreshed at most once per hour). Logout deletes the row.
- Alternatives: signed stateless cookies (rejected: not revocable); Redis (rejected: optional in Community).
- Consequences: One indexed lookup per authenticated request. Plain-HTTP LAN installs work; HTTPS installs get `Secure` cookies.

## ADR-034: CSRF defence and auth hardening

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §14 requires CSRF protection on cookie auth, rate limits on auth endpoints and argon2id passwords.
- Decision: SameSite=Lax cookies plus a server-side check on every state-changing `/api/v1` request: reject with 403 when `Sec-Fetch-Site` is present and not `same-origin`/`none`, or when `Origin` is present and does not match the request's own host (or `WATCHLOG_PUBLIC_URL`). Bodies must be JSON (the `text/plain` parser is removed). `@fastify/rate-limit` (in memory) on login and setup. Passwords: argon2id via `@node-rs/argon2` (m = 19 MiB, t = 2, p = 1; OWASP), minimum 10 characters; unknown emails still run a dummy verification so timing does not reveal accounts.
- Alternatives: synchronizer/double-submit tokens via `@fastify/csrf-protection` (rejected: token plumbing in the SPA without extra protection over Fetch Metadata + Origin for supported browsers).
- Consequences: Non-browser clients (no `Origin`, no `Sec-Fetch-Site`) are allowed; they cannot carry a victim's cookie.

## ADR-035: A default org in Community mode; RLS in Phase 5

- Date: 2026-10-31 · Status: accepted
- Context: Cloud multi-tenancy (SPEC §5.4) must not need a schema change later.
- Decision: First-run setup creates an org `default` (plan `community`) and an `owner` membership. Every tenant table has `org_id NOT NULL` from its first migration. Row-Level Security policies are added in Phase 5 (tracked in the phase 5 checklist (private notes)); until then the data-access layer always scopes by org and tests cover it.
- Alternatives: no org in Community (rejected: schema change and data migration later); RLS now (rejected: per-request transactions with `set_config` before there is a second tenant).
- Consequences: Community users see no org concept in the UI.

## ADR-036: Apache ECharts with modular imports and a token-aware wrapper

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §5.1 names Apache ECharts; all colours must come from tokens.
- Decision: Import from `echarts/core` with only the charts/components used, wrapped in our own small Vue component that reads `--chart-*`, `--border` and `--text-muted` from CSS at runtime. No vue-echarts.
- Alternatives: vue-echarts (rejected: extra dependency for a thin wrapper).
- Consequences: Chart colours follow a future light theme automatically.

## ADR-037: How Phase 1 acceptance is verified

- Date: 2026-10-31 · Status: accepted
- Context: Docker Desktop does not expose the real host `/proc` or cgroups (measured), so it cannot stand in for a "fresh VM".
- Decision: Lima on the Mac runs Ubuntu 24.04 VMs with Docker Engine, created by scripts in `deploy/test/` (Claude runs them). A second VM booted with cgroup v1 provides v1 fixtures. If cloud-images.ubuntu.com or Docker's packages are unreachable, use Ubuntu's `docker.io` package. The same acceptance scripts also run in CI on `ubuntu-24.04` (a fresh VM each run, manual trigger). Tests: (1) compose up + one `docker run` → host and container metrics through the API within 60 s; (2) 30 busybox containers (healthy, unhealthy, restarting, a 3-service Compose project), agent RSS sampled every 5 s for 10 minutes, fail above 64 MB; (3) stop the backend for 5 minutes, restart, query `count_over_time(...[15s])` at a 15 s step across the window, fail on any gap. OrbStack is not used.
- Alternatives: Docker Desktop (rejected: not a real host); cloud VMs (rejected: may be blocked from the owner's network, cost).
- Consequences: Acceptance runs on arm64 (Lima) and amd64 (CI).

## ADR-038: Neutral grey palette and restrained use of the brand green in the app

- Date: 2026-10-31 · Status: accepted (SPEC §11.1 and §11.3 updated)
- Context: The SPEC §11.1 neutrals are green-tinted, and the active nav item and empty-state icons used green backgrounds and text; together this tires the eyes. The owner compared two neutral palettes visually and chose palette A (cool grey).
- Decision:
  - Neutrals: `--bg #0E0F11`, `--surface-1 #15171A`, `--surface-2 #1B1E22`, `--surface-3 #22252A`, `--border #2A2E34`, `--border-strong #3A3F46`, `--text #E8EAED`, `--text-muted #9BA1A9`, `--text-subtle #6B7179`. `--primary`, `--primary-hover`, `--primary-soft`, `--on-primary`, status colours and the chart palette are unchanged.
  - Active nav item: `--surface-2` background, `--text` colour and a 2px `--primary` bar on the left; no green background or text.
  - Empty-state icon box: `--surface-2` background with a `--text-muted` icon.
  - No `--primary-glow` in the app: the focus ring is a plain `2px solid var(--primary)`. The token stays for the site (hero glow).
- Alternatives: palette B (pure neutral greys; not chosen); keeping the green-tinted neutrals (rejected: eye strain).
- Consequences: Measured contrast (WCAG): `--text` 12.8–15.9:1 and `--text-muted` 5.9–7.4:1 on all backgrounds (AA). `--text-subtle` is 3.1–3.9:1, below AA for body text, so it must stay limited to disabled text and decorative icons (≥ 3:1 non-text minimum); the web app currently uses it only for icons. The design-tokens test checks the new values.

## ADR-039: Community edition allows one cluster or Docker fleet from the start

- Date: 2026-10-31 · Status: superseded by ADR-151 (2026-11-10)
- Context: SPEC §3.2 limits Community to one cluster / Docker fleet, and SPEC §3.1 says nothing that was ever free becomes paid. Allowing several clusters now and limiting later would take something away.
- Decision: `POST /clusters` returns 409 with problem type `urn:watchlog:problem:cluster-limit` when an org on plan `community` already has a cluster. A Docker fleet holds any number of hosts, so self-hosters add hosts to the existing fleet. Other plans have no cluster limit until plan limits arrive in Phase 5.
- Alternatives: no limit until Phase 5 (rejected: would later remove a free capability); 402 (rejected: Community has nothing to pay for).
- Consequences: The UI explains the limit and points to the existing fleet's install command.

## ADR-040: Token rotation by issuing an additional token

- Date: 2026-10-31 · Status: accepted
- Context: SPEC §8.1 lists `POST /clusters/:id/tokens` (rotate) and `DELETE …/tokens/:tid` (revoke). Revoking the old token at the moment a new one is issued would cut off every running agent until it is reconfigured.
- Decision: `POST /clusters/:id/tokens` issues an additional active token (value returned once with the install command); old tokens stay valid until revoked with `DELETE`. At most 5 active tokens per cluster (409, `urn:watchlog:problem:token-limit`). Revoking is idempotent.
- Alternatives: rotate = replace (rejected: downtime); unlimited tokens (rejected: forgotten credentials pile up).
- Consequences: Rotation is three steps (issue, update agents, revoke), explained in the UI.

## ADR-041: Typed RFC 9457 problems for errors clients branch on

- Date: 2026-10-31 · Status: accepted
- Context: Several conflicts share status 409 (cluster limit, duplicate name, token limit), and the web app must show translated messages without parsing English `detail` text.
- Decision: Problems the client must distinguish carry a `type` URN (`urn:watchlog:problem:cluster-limit`, `…:name-taken`, `…:token-limit`); all others keep `about:blank`. New types are added to `ProblemType` in the backend and mirrored in the web client.
- Alternatives: custom error codes in an extension member (rejected: RFC 9457 `type` exists for this); parsing `detail` (rejected: brittle, not localisable).
- Consequences: `detail` stays human-readable English for API users and logs.

## ADR-042: 401, 403, 404 and 405 pause the sender instead of dropping batches

- Date: 2026-10-31 · Status: accepted (approved 2026-10-31)
- Context: ADR-022 drops batches on "any other 4xx" so a poison batch cannot block the queue. Running the agent in the test VM against a backend without the ingest route returned 404, and the agent dropped every batch. A 404 (or 403/405) means the endpoint or token is wrong or the backend is older, not that the batch is bad; dropping turns a misconfiguration into silent data loss.
- Decision: The sender treats 401, 403, 404 and 405 as configuration problems: keep the batch, log a clear message naming `WATCHLOG_TOKEN` or `WATCHLOG_ENDPOINT`, and retry after 5 minutes (the buffer's 15 min / 200 MB limits still apply). 400, 402, 409, 413, 415, 422 and other 4xx remain poison batches and are dropped and counted. Network errors, 408, 429 and 5xx retry with backoff, as before.
- Alternatives: drop on 404 (rejected: data loss on misrouted proxies); retry 404 with normal backoff (rejected: floods the log and the server while misconfigured).
- Consequences: The self-metric outcome label is `paused` instead of `unauthorized`.

## ADR-043: No image publishing until the Phase 4 open-source launch

- Date: 2026-10-31 · Status: accepted
- Context: ADR-014 names `ghcr.io/watchlog-light/{agent,backend,web}` and defers pushing. Community installs currently build images from source with `compose.build.yaml`, and Phase 2 needs agent images inside kind clusters.
- Decision: Nothing is pushed to GHCR (or any registry) until the **Phase 4 open-source launch**, and then only with cosign signing (SPEC §14). Until then CI builds images without pushing, Community installs use `compose.build.yaml`, and Phase 2 kind tests use locally built images loaded with `kind load docker-image`.
- Alternatives: publish unsigned images now (rejected: a private repository with public images, and no signing); a private registry for tests (rejected: credentials in CI for no gain over `kind load`).
- Consequences: Test manifests and Helm values reference local tags with `imagePullPolicy: IfNotPresent` (or `Never`). Publishing is a Phase 4 task together with the signing workflow.

## ADR-044: CI runs on push to main, except docs-only changes (amends ADR-018)

- Date: 2026-10-31 · Status: accepted
- Context: ADR-018 kept every workflow manual until the owner approved triggers. Phase 1 is complete and CI has been green; the owner approved automatic runs.
- Decision: The CI workflow runs on **push to `main`** and on `workflow_dispatch`. Pushes that change only `docs/**` or `**/*.md` are skipped (`paths-ignore`). The fresh-runner acceptance job stays **manual only** (`if: github.event_name == 'workflow_dispatch'`), because it builds all images and takes several minutes. No workflow pushes images (ADR-043).
- Alternatives: also run on pull requests (not requested yet; work lands on `main` directly); run acceptance on every push (rejected: slow, and it changes rarely).
- Consequences: Commits that touch both code and docs still run CI. Acceptance #1 is re-run by hand before releases and when the install path changes.

## ADR-045: VictoriaMetrics search latency offset of 5 s

- Date: 2026-10-31 · Status: accepted
- Context: VictoriaMetrics hides the last 30 s of data from queries by default (`-search.latencyOffset`), so a new agent's first samples stayed invisible and acceptance #1 took 46 s of its 60 s budget.
- Decision: The Community and dev compose files start VictoriaMetrics with **`-search.latencyOffset=5s`**. Agents push every 15 s, so samples arriving later than 5 s are rare.
- Alternatives: keep 30 s (rejected: slow first impression, little margin on the 60 s target); 0 s (rejected: partially written intervals make the newest point jump).
- Consequences: Time to first metric on the fresh VM went from 46 s to 20 s. A sample that arrives more than 5 s late can be missing from a query issued in that window, then appears on the next refresh. The Cloud deployment (Phase 5) uses the same value unless measured otherwise.

## ADR-046: Page loading states and list filters in the web app

- Date: 2026-10-31 · Status: accepted
- Context: Each page handled loading on its own (a "…" in charts, nothing elsewhere), errors without a way to retry, and data that blinked on every poll. The Docker lists needed search.
- Decision: Pages load through `useLoader`: a skeleton (the `Skeleton*` components in `web/src/components/ui`) appears only when the first load takes longer than **150 ms** (`useDelayedFlag`); refetches keep the data visible with `LoadingIndicator`; failures show `ErrorState` with Retry, full-size without data and as an inline banner above stale data. Loading, empty and error never share a state. Where content below is already on screen (charts under a detail header), the skeleton's space is reserved invisibly from the start so nothing moves. List filters are client-side and live in the URL query (`?q=&status=`) via `useListFilter`, debounced 150 ms; one page-level search box covers the page's lists, `/` focuses it.
- Alternatives: spinners (rejected: layout jumps and no sense of the page's shape); skeletons without a delay (rejected: flicker on fast local responses); server-side search (rejected for now: Docker lists are small and already loaded).
- Consequences: New pages use `useLoader` and the skeleton components instead of their own flags. Skeletons mirror the real markup (same classes, `1lh` lines), so a layout change must update both. Lists over a few thousand rows would need server-side filtering.

## ADR-047: Container health and exit details, with redaction and an output opt-out

- Date: 2026-10-31 · Status: accepted
- Context: The container page showed "Unhealthy" or "Exited" without a reason. The reason is in the inspect response the agent already reads: `State.Health` (status, failing streak, the last five probes with output) and `Config.Healthcheck`, plus `State.Error`, `FinishedAt` and `Restarting`. Probe output and check commands are written by image authors and can contain credentials. Measured on the Lima VM (Docker 29.9.2): `health_status` events fire only on transitions, not on every probe; Docker can miss an OOM kill that happens within milliseconds of start (exit 137, `OOMKilled=false`, no `oom` event, while the kernel log shows the kill).
- Decision: The agent decodes those fields (never `Config.Env`, `Config.Cmd`, `Path` or `Args`) and sends them in the inventory as `health_detail` (status, failing streak, last 5 probes, check with daemon defaults applied), `error`, `finished_at` and `restarting`. Probe output, the check command and `State.Error` are redacted (`agent/internal/redact`), folded to one line and truncated to 512 bytes; `WATCHLOG_HEALTH_OUTPUT=false` omits probe output entirely. A `die`, `oom` or `health_status` event re-inspects that container and posts an inventory **delta** (`kind: "delta"`, only the changed containers) after a 1 s coalescing wait; unhealthy containers are re-inspected every minute instead of every 5. The backend keeps the time the health status last changed.
- Alternatives: send raw output and redact in the backend (rejected: secrets would leave the host); never send output (rejected: the output is usually the reason, e.g. "Connection refused"); subscribe to `exec_*` events for per-probe updates (rejected: they fire every interval and contain the full command).
- Consequences: Redaction is pattern-based; the opt-out exists for hosts where that is not enough. The UI must not rely on the OOM flag alone: exit 137 is shown as "killed (SIGKILL)", with out-of-memory as a likely cause when a memory limit is set. While a container is unhealthy, its probe log changes the inventory hash, so the snapshot is re-sent at most once a minute.

## ADR-048: Two binaries and images: agent and cluster-agent (amends SPEC §6.2)

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D1)
- Context: SPEC §6.2 asks for one binary with three modes. Measured with client-go v0.37.2: the stripped agent grows from 7.1 MB to 28.5 MB (amd64), and a binary that merely links client-go idles at 18.5 MB RSS instead of 7.2 MB, because package `init()` registers every API type. Node agents would pay this on every node without using it.
- Decision: One Go module, two binaries and two images: `agent` (`--mode=node|docker`, no client-go) and `cluster-agent` (client-go). Shared packages (sender, buffer, remote_write, metrics) stay common. `agent --mode=cluster` exits with a message pointing to the cluster-agent image.
- Alternatives: One binary (rejected: +11 MB RSS on every node, and eBPF later would push the image past 40 MB); an own list/watch client without client-go (rejected: re-implements reflector, relist and leader election semantics).
- Consequences: Helm references two images; CI builds both. Node agent RSS keeps the Phase 1 profile.

## ADR-049: Container-to-pod mapping without the CRI socket or nodes/proxy (amends SPEC §6.3, §6.6)

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D2)
- Context: SPEC §6.3 maps containers to pods through the CRI socket, §6.6 grants `nodes/proxy` for the kubelet. The CRI API is read-write (create, exec, remove containers); `nodes/proxy` GET is known to allow command execution through the kubelet's websocket exec path. The cluster-agent already resolves owners to workloads.
- Decision: The node agent reads pod UID and container ID from cgroup paths (ADR-050) and gets namespace, pod, container and workload names from a map the cluster-agent serves (ADR-066). It calls the kubelet only for `/stats/summary` (`nodes/stats`). Node-level metrics never depend on the cluster-agent: host series are always sent. The node agent keeps the last map on disk (emptyDir) and uses it across restarts and cluster-agent outages. Series of containers not yet in the map are held up to 60 s, then dropped and counted in `watchlog_agent_unmapped_containers_total`. Pod UIDs and container IDs are never labels.
- Alternatives: CRI socket (rejected: write access to the runtime); kubelet `/pods` via `nodes/proxy` (rejected: exec risk); node agents watching the API server (rejected: SPEC §6.4/§6.5, API server load at scale).
- Consequences: A new pod's container series can start up to one map refresh late; the 60 s hold covers normal scheduling.
- Measured (slice 1): sandbox cgroups (ADR-050) are recognised on the node and never count as unmapped. Static pods are mapped by their config hash, so the pod map also indexes mirror pods by `kubernetes.io/config.mirror`.
- Implemented (slice 4): `watchlog_agent_unmapped_containers_total` counts containers and pods (kubelet summary series) given up after the hold, plus cgroups of uncaptured layouts. Held samples keep their own timestamps. Measured on kind without `hostPID`: `cgroup.procs` of other pods lists no PIDs in the agent's PID namespace, so the `pause` check cannot run; a container cgroup whose pod is in the map but whose ID is still absent from a map fetched ≥ 10 s after the cgroup appeared is treated as the sandbox (no metrics, not counted). Live result: unmapped 0 on all three nodes, container series per node equal to the API server's running containers.
- Measured (slice 9): an OOM-killed container in a crash loop lives about 4 s and its cgroup is gone before the pod map names it; held keys of vanished cgroups now wait out the 60 s hold and are released when the map lists the ID among the pod's last-terminated containers (before, the OOM-looping pod had no memory series). With a 15 s scrape such a container yields about one sample per run.

## ADR-050: Kubernetes cgroup layouts from captured fixtures

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D3)
- Context: Container runtimes and cgroup drivers name pod and container cgroups differently, and SPEC §6.1 requires containerd, CRI-O and Docker Engine.
- Decision: The node agent supports the systemd driver (`kubepods.slice/kubepods-<qos>.slice/kubepods-<qos>-pod<uid>.slice/<runtime>-<id>.scope`), the cgroupfs driver (`kubepods/<qos>/pod<uid>/<id>`), cgroup v2 and v1, and kind's nesting under `kubelet.slice`. Patterns are derived only from trees captured on kind, k3s, k3s on cgroup v1, k3s with Docker Engine and kubeadm with CRI-O, with pod JSON as ground truth.
- Alternatives: Patterns from documentation (rejected: never infer shapes, CLAUDE.md).
- Consequences: A new runtime or driver needs a captured fixture before support.
- Measured (slice 1, 2026-10-31; fixtures in `agent/internal/collectors/containers/testdata/k8s/`): kind 0.33 / k8s 1.37 (containerd, systemd driver, cgroup v2, nested as `kubelet.slice/kubelet-kubepods.slice/…`), k3s 1.36.5 (containerd, systemd, v2), k3s on cgroup v1 (containerd, systemd), k3s with Docker 29.9.2 (cri-dockerd, **cgroupfs** driver, v1: `kubepods/<qos>/pod<uid>/<id>`), kubeadm 1.36 with CRI-O 1.36.7 (systemd, v2). Findings: (1) pods without a QoS slice are Guaranteed; (2) systemd slice names write the pod UID with `_`; (3) **static pods** use the kubelet's 32-hex config hash instead of the UID — the API shows it as the mirror pod's annotation `kubernetes.io/config.mirror`; (4) each pod also has a **sandbox** cgroup with an ID absent from the pod status: containerd and Docker run `pause` in it, CRI-O 1.36 leaves it without processes (`crio-<id>`, no `.scope`); (5) CRI-O puts container processes one level down (`crio-<id>.scope/container`), usage is read at the `.scope`; (6) an uninstalled runtime can leave an empty `kubepods.slice` next to the active `kubepods` tree. Not captured: Docker or containerd with cgroupfs on v2, CRI-O with cgroupfs.

## ADR-051: Kubelet TLS: auto, verify or skip

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D4)
- Context: The node agent reads `https://$HOST_IP:10250/stats/summary`. Many clusters (kind, kubeadm) serve the kubelet with self-signed certificates, so verification-only would fail there and delay the first metrics.
- Decision: Helm value `kubelet.tls: auto|verify|skip`, default `auto`: try a verified connection against the cluster CA first; only if verification fails, connect without verification. The heartbeat reports `capabilities.kubelet_tls: verified|unverified`, and the UI shows a warning badge on the node with how to fix it (serving certificates signed by the cluster CA, e.g. `serverTLSBootstrap`). `verify` never falls back; `skip` never verifies. The ServiceAccount token is only sent to the node's own kubelet at `status.hostIP`. Measured per cluster: see the slice 1 measurements below.
- Alternatives: Verify only (rejected: breaks kind/kubeadm, hurts time to first metric); skip by default (rejected: silent).
- Consequences: Slice 1 measurements fill in which test clusters verify cleanly.
- Measured (slice 1, `deploy/test/k8s/kubelet-tls-probe.yaml`: a pod calling `https://$HOST_IP:10250/stats/summary` with its ServiceAccount CA): **kind 1.37 — fails** (self-signed kubelet serving certificate); **kubeadm 1.36 + CRI-O — fails** (self-signed); **k3s 1.36.5 — verifies** (kubelet serving certificate signed by the cluster CA), also with cgroup v1 and with Docker. So `auto` falls back on kind and kubeadm defaults and verifies on k3s.

## ADR-052: Phase 2 informers

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D5)
- Context: SPEC §6.5 lists informers including Services, Endpoints/EndpointSlices, Ingresses and PVs, which only the service map (Phase 4) needs.
- Decision: Phase 2 cluster-agent informers: Nodes, Namespaces, Pods, Deployments, ReplicaSets (owner resolution only, not sent), StatefulSets, DaemonSets, Jobs, CronJobs, HPAs (`autoscaling/v2`), PVCs, Events (`events.k8s.io/v1`). The others arrive with Phase 4.
- Alternatives: All of SPEC §6.5 now (rejected: memory and RBAC for unused data).
- Consequences: SPEC §6.5 notes the Phase 4 additions.

## ADR-053: Object trimming with SetTransform

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D6)
- Context: Informer caches hold full objects; pod specs carry env, commands and args that can contain credentials (Phase 1 health checks did), and nodes carry long image lists.
- Decision: A `SetTransform` drops `managedFields`, keeps annotations only from an allow-list (`deployment.kubernetes.io/revision`, `kubernetes.io/change-cause`, `kubernetes.io/config.mirror`), caps labels (64 per object, values ≤ 256 characters), removes container `env`, `envFrom`, `command`, `args`, probe and lifecycle `exec` commands and volume sources other than PVC claim names, and node `status.images`. There are no Secret or ConfigMap informers.
- Alternatives: Trimming only when sending (rejected: secrets would still sit in memory; larger cache).
- Consequences: The UI cannot show commands or env; that is intended.
- Amended (slice 1): the allow-list also keeps `kubernetes.io/config.mirror`; static pods are found on the node by this hash (ADR-050).

## ADR-054: Cluster-agent leader election

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D7)
- Context: Two cluster-agent pods (rollouts, misconfigured replicas) must not both send.
- Decision: client-go leader election with a Lease in the release namespace (Role: `get/create/update` on `leases` in that namespace only); 1 replica by default.
- Alternatives: No election (rejected: double sending during rollouts).
- Consequences: Failover takes up to the lease duration (15 s).
- Measured (slice 4): only the leader serves the pod map and turns ready, so the single-replica Deployment must use `strategy: Recreate`; a rolling update waited forever for the follower to become ready. The Helm chart (slice 5) must do the same.

## ADR-055: Kubernetes objects over /ingest/v1/objects

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D8)
- Context: The objects endpoint and table hold Docker inventory (ADR-029). Kubernetes snapshots at 15k pods exceed the 16 MiB decoded limit in one request.
- Decision: `/ingest/v1/objects` accepts `source: "kubernetes"`: `{kind: snapshot|delta, snapshot_id, final, objects:[{kind, uid, namespace, name, node, spec, status, deleted}]}`. Snapshots (on start and every 10 min) are chunked at ≤ 2,000 objects; the final chunk marks objects of the snapshot's kinds not seen in it deleted. Deltas are batched every 5 s. Rows go into the existing `objects` table (uid = `metadata.uid`, node = `spec.nodeName` or the node's name).
- Alternatives: A separate endpoint and table (rejected: duplicates the Phase 1 path).
- Consequences: A sweep column (snapshot id or last-seen time) is added by migration in slice 2.

## ADR-056: Kubernetes state metrics; requests and limits stay on objects

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D9)
- Context: SPEC §6.5 asks for kube-state style metrics; at 15k pods every per-container series multiplies.
- Decision: Series `watchlog_kube_`: `pod_status_phase` (current phase only), `pod_info{node,workload_kind,workload,qos_class}`, `pod_container_restarts_total`, `pod_container_status_waiting_reason` (while waiting), `pod_container_last_termination_reason` and `_exit_code`, `deployment_replicas`, `statefulset_replicas`, `daemonset_replicas{state}`, `job_status{state}`, `hpa_replicas{state}`, `node_condition{condition,status}`, `node_status_allocatable` and `node_status_capacity{resource}`, `node_info{…versions}`, `pvc_capacity_bytes`. Labels `namespace, pod, container, node, workload_kind, workload`; never UIDs or IPs. Requests and limits are stored on the objects, not as series; charts show usage vs the current requests as a flat line. Cluster-agent series cap 150,000 (node > workload > pod > container), drops counted.
- Alternatives: Requests/limits as series (rejected: ~60k static series at 15k pods).
- Consequences: A change of requests over time shows as a change marker (rollout), not as a stepped line.
- Measured (slice 3): 15,008 Running pods (kwok, 500 nodes, 1,505 Deployments) → **74,079** `watchlog_kube_*` series (≈ 4.9 per pod; largest: container restarts 30,009, pod phase 15,008, pod info 15,008), none dropped. The runner splits each scrape into remote_write requests of ≤ 20,000 series; at start the snapshot chunks plus metric batches exceed the per-agent burst (20) and two requests got 429 and were retried from the buffer, steady state stays below 1 request/s.

## ADR-057: Agent and cluster-agent image budgets

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D10)
- Context: SPEC §6.1: image ≤ 40 MB. Measured: agent 7.1 MB, cluster-agent ≈ 29 MB (amd64, stripped).
- Decision: Both images FROM scratch (ADR-020), amd64 and arm64, each ≤ 40 MB; CI reports sizes.
- Alternatives: —
- Consequences: eBPF (Phase 4) only grows the agent image.

## ADR-058: Cluster-agent memory target and test

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D11)
- Context: No SPEC budget exists for the cluster-agent; caches grow with cluster size.
- Decision: Estimate 150–250 MB at 500 nodes / 15k pods with trimmed objects; Helm default request 128Mi, limit 512Mi. Verified in slice 2 by a heap benchmark (500 nodes, 15k pods built from captured fixtures) and by kwok on kind (`registry.k8s.io/kwok`, reachable).
- Alternatives: —
- Consequences: Defaults are revised with the measurements.
- Measured (slice 2, 2026-10-31): trimmed informer caches for 500 nodes, 1,500 Deployments with 4,500 ReplicaSets and 15,000 pods (cloned from kind objects) retain **118 MiB** (`agent/internal/k8s/memory_test.go`). Against a real API server (k3s 1.36.5 + kwok 0.7.0: 500 fake nodes, 15,000 Running pods, 17,071 sent objects; `deploy/test/k8s/kwok-scale.py`): caches synced in 1.7 s, snapshot delivered in 9 chunks 2 s later; Go heap peak 202 MB during the initial list, live heap after sync **132 MB** (gctrace; the agent ran on the Mac against the VM's API server because the VM's memory was taken by k3s, macOS max RSS 254 MB). The 128Mi request / 512Mi limit defaults stand; slice 5 should also set `GOMEMLIMIT` below the limit.

## ADR-059: Own Helm charts, official images, no Bitnami

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D12)
- Context: SPEC §5.3 needs `watchlog` (full) and `watchlog-agent` charts; the owner rules out Bitnami.
- Decision: `deploy/helm/watchlog-agent` (DaemonSet, cluster-agent, RBAC) and `deploy/helm/watchlog` (backend, web, migrate Job, VictoriaMetrics and PostgreSQL StatefulSets with `victoriametrics/victoria-metrics` and `postgres:16-alpine`, `watchlog-agent` as a `file://` dependency). Chart `apiVersion: v2` (Helm 3 and 4). Our images keep `ghcr.io/watchlog-light/*` names and are loaded locally in tests (ADR-043).
- Alternatives: Bitnami subcharts (rejected by the owner).
- Consequences: We maintain the StatefulSet templates.

## ADR-060: RBAC and PodSecurity for Kubernetes

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D13)
- Context: SPEC §6.6 grants `nodes/proxy` and eBPF capabilities; Phase 2 needs neither.
- Decision: cluster-agent ClusterRole: `get/list/watch` on the ADR-052 resources and `create` on `tokenreviews` (ADR-066). Node agent ClusterRole: `get` on `nodes/stats`. No Secrets, ConfigMaps or `nodes/proxy`. Node agent pod: `hostNetwork: false`, `hostPID` only if measured necessary, uid 65532, read-only root filesystem, all capabilities dropped and none added (eBPF in Phase 4), seccomp `RuntimeDefault`, `/proc` and `/sys` as read-only hostPath. Namespace labels `pod-security.kubernetes.io/enforce: privileged` (baseline forbids hostPath), `audit` and `warn: baseline`. docs/security.md documents each item.
- Alternatives: Baseline enforcement (rejected: hostPath is required for host metrics).
- Consequences: Other workloads in the release namespace are not protected by PodSecurity; the chart creates its own namespace.
- Measured (slice 4, kind 1.37): the node agent works with `hostPID: false` (sandboxes recognised through the pod map, ADR-049), no capabilities, uid 65532 and a read-only root filesystem; `hostPID` is not needed in Phase 2. The cluster-agent runs under the `restricted` profile's settings.

## ADR-061: Kubernetes events storage and change markers

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D14)
- Context: SPEC §4.6: store all events for the retention period, de-duplicated by involved object and reason; change markers on charts.
- Decision: `k8s_events` range-partitioned by day; unique `(cluster_id, day, involved_uid, reason)`; an upsert bumps `count`, `last_ts` and `message`. A backend job drops partitions past retention (15 d Community) and creates three days ahead. Change markers are derived in the backend from object changes: template revision → rollout, container image → image, replicas or HPA desired replicas → scale, node added or removed → node.
- Alternatives: Markers computed in the agent (rejected: logic in every agent version).
- Consequences: An event recurring over midnight gets one row per day.
- Implemented (slice 3): a row is `(cluster_id, day, involved_key, reason)` with `day` = UTC date of the event's last occurrence; `involved_key` is the involved object's uid (or kind/namespace/name). `event_counts` holds the latest count per Kubernetes Event object and `count` is their sum, so re-sending events after a restart is idempotent; `count` is the cumulative count Kubernetes reports, not a per-day count. Events past retention are skipped, future-dated ones land on today. The table has no `id` column (a partitioned table's key must contain the partition column). Change markers are derived for Deployments, StatefulSets, DaemonSets and Nodes, from deltas and later snapshots alike; HPA-driven scaling shows as the workload's `scale` marker (no separate HPA marker). Measured on kind: image, rollout and scale markers 5 s after `kubectl set image` / `scale`.

## ADR-062: Label names for Kubernetes series

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D15)
- Context: SPEC §6.3 labels Kubernetes series with `node`; Docker series use `host` (Phase 1).
- Decision: Kubernetes series use `node`, Docker keeps `host`; the query catalog selects the label by cluster kind.
- Alternatives: Renaming Docker's label (rejected: breaks Phase 1 data).
- Consequences: Catalog entries carry the machine label per kind.

## ADR-063: Test clusters for Phase 2

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D16)
- Context: Measured on 2026-10-31: registry.k8s.io, Docker Hub (kindest/node v1.37.0, rancher images), get.k3s.io, update.k3s.io (stable v1.36.5+k3s1), GitHub release assets, quay.io, ghcr.io and gcr.io are reachable from the owner's network (gcr.io was 403 earlier). The Mac has 18 GiB RAM and 31 GiB free disk.
- Decision: kind 0.33 (Homebrew) with `kindest/node:v1.37.0`, one control plane and two workers on Docker Desktop; k3s v1.36.5 on two Lima VMs (server and agent); k3s on `watchlog-cgv1` for cgroup v1 (an older k3s if the kubelet refuses v1); a temporary kubeadm + CRI-O VM only for fixtures. `watchlog-fresh` is stopped while the k3s VMs run. If a registry gets blocked: pre-pull plus `kind load` / `k3s ctr images import`, k3s air-gap tarballs.
- Alternatives: minikube (rejected: its base image comes from gcr.io).
- Consequences: Scripts live in `deploy/test/k8s` and `deploy/test/lima`.
- Measured (slice 1): Lima `vzNAT` reached the VMs from the Mac but **not VM to VM** (macOS vmnet isolation); the k3s VMs use Lima `user-v2` instead (no root needed) and the Mac reaches the API server through Lima's forward of 6443. The 1.36 kubelet **refuses cgroup v1** ("configured to not run on a host using cgroup v1") unless started with `--kubelet-arg=fail-cgroupv1=false`. The `pkgs.k8s.io` CDN path for CRI-O returned **403** from the owner's network while the Kubernetes core path worked; CRI-O packages come from `download.opensuse.org`, and the package ships its bridge CNI config disabled.

## ADR-064: A real multi-node cluster for acceptance

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D17)
- Context: SPEC §13 Phase 2 accepts on one real multi-node cluster; the owner has none yet.
- Decision: Any provider with three VMs, or an existing three-node cluster the owner gets access to; the owner chooses (pending review). Only the final acceptance run depends on it.
- Alternatives: —
- Consequences: Phase 2 can complete everything else first.
- Deferred 2026-11-01 by the owner: the real multi-node run moves to before the Phase 4 launch; Phase 2 is complete without it.

## ADR-065: Kubernetes e2e test on kind in CI

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D18)
- Context: SPEC §13: the e2e test on kind runs in CI; ADR-043 forbids pushing images.
- Decision: Job `e2e-kind` in `ci.yml`, run only on `workflow_dispatch`: build the images, `kind load` them, `helm install`, run `deploy/test/k8s/e2e.sh` (CrashLoopBackOff and OOMKilled within 30 s, P0 endpoints).
- Alternatives: Running on every push (rejected: slow, like the acceptance job).
- Consequences: Triggered by hand before releases. Shipped as `deploy/test/k8s/e2e.sh` + `acceptance.py` (slice 9); a fresh kind install took 3 min to a 26/26 result locally.

## ADR-066: Node-scoped pod map served by the cluster-agent, authenticated by TokenReview

- Date: 2026-10-31 · Status: accepted (Phase 2 plan, D2)
- Context: ADR-049 has node agents fetch names from the cluster-agent instead of the API server. The endpoint must only answer node agents, and each node only about its own pods.
- Decision: The cluster-agent serves `GET /v1/podmap` over HTTPS inside the cluster; the chart generates a CA and a server certificate at install (kept on upgrade), mounts the key only into the cluster-agent and the CA only into node agents (mounted by the kubelet, so neither agent needs Secret RBAC). Never plain HTTP: the request carries a ServiceAccount token. Node agents send their projected ServiceAccount token (audience `watchlog-cluster-agent`); the cluster-agent validates it with a TokenReview (needs `create` on `tokenreviews`), requires the node agent's ServiceAccount, reads the bound pod name and UID from the review's `extra` and serves only the pods on that pod's node (from its informer cache). Results are cached per token for up to 5 minutes to protect the API server.
- Alternatives: Shared static secret (rejected: one leak serves every node's data); NetworkPolicy only (rejected: not enforced by every CNI, no identity); node agents reading the API server (rejected: ADR-049).
- Consequences: Works on Kubernetes 1.26+ (pod-bound tokens); docs/security.md lists the TokenReview permission.
- Measured (slice 4, kind 1.37): TokenReview of the projected token (audience `watchlog-cluster-agent`) authenticates the node agents; the pod map reached all three nodes over HTTPS with a test CA (`deploy/test/k8s/agents-up.sh`); unknown tokens get 401, other ServiceAccounts 403, reviews are cached.

## ADR-067: Ingest bucket for the cluster-agent (amends ADR-027)

- Date: 2026-10-31 · Status: accepted (requested by the owner, overnight run 2)
- Context: The per-agent bucket (1 req/s, burst 20) is sized for node agents. At 15,000 pods the cluster-agent sends ~25 requests at once on start (9 snapshot chunks, ~4 state metric batches, event batches, the heartbeat); two got 429 in the slice 3 kwok run.
- Decision: Requests with `X-WatchLog-Agent: cluster-agent` use their own bucket of **5 req/s sustained, burst 100**; node agents keep 1 req/s / 20. The per-cluster ceiling (250 req/s, burst 500) still applies, so a client claiming the name cannot exceed it.
- Alternatives: a larger per-agent bucket for everyone (rejected: loosens the limit for every node); pacing the cluster-agent's start (rejected: delays the first snapshot).
- Consequences: Measured with k3s + kwok, 15,000 Running pods, 17,071 objects: **0 responses with 429** among 72 requests in the first 75 s (before: 2). Steady state stays below 1 request/s.

## ADR-068: Cluster-agent standbys are ready; RollingUpdate (amends ADR-054)

- Date: 2026-10-31 · Status: accepted (requested by the owner, overnight run 2)
- Context: Slice 4 tied readiness to leadership (only the leader started its informers and the pod map), which forced `strategy: Recreate`.
- Decision: Every replica starts its informers and serves the pod map once its caches are synced, so a synced standby is ready; only the Lease holder ships objects, events and state metrics. The leader releases the Lease on SIGTERM (`ReleaseOnCancel`), and the Helm chart uses `RollingUpdate` (maxSurge 1, maxUnavailable 0).
- Alternatives: Recreate (kept as the fallback if the handover misbehaves); standbys answering 503 for the pod map (rejected: node agents would hit them through the Service).
- Consequences: A standby holds a second informer cache while it exists (only during rollouts with one replica). Measured (slice 5, kind 1.37, `helm upgrade` changing the cluster-agent's pod template, 4 runs): the Lease was released on SIGTERM and taken by the new pod after **2.3, 2.7, 2.7 and 2.9 s** (bounded by the 2 s retry period); the new leader sent its snapshot in the same second; node agents logged no pod map errors (a ready replica was behind the Service throughout). Recreate is not needed.

## ADR-069: The watchlog chart registers its own cluster

- Date: 2026-10-31 · Status: accepted 2026-11-01 with one change (below)
- Context: `helm install watchlog` installs the server and the agents in one step, but agents need a cluster token, and tokens are issued by an organisation that exists only after the setup screen (ADR-030).
- Decision: The chart generates a token (`wl_ct_` + 43 random characters, Secret `<release>-cluster-token`, kept on upgrades via `lookup`) and passes it to the backend as `WATCHLOG_BOOTSTRAP_CLUSTER_TOKEN` (name `WATCHLOG_BOOTSTRAP_CLUSTER_NAME`, default `kubernetes`). On start and right after setup completes, the backend creates that Kubernetes cluster in the first organisation and stores the token's hash, unless the token already verifies. The agents read the same Secret (`existingSecret`) and push to the backend Service; they retry until setup is done. `POST /clusters` with kind `kubernetes` returns a `helm install watchlog-agent …` command for other clusters.
- Alternatives: asking the user to create a cluster in Settings and `helm upgrade` with the token (rejected: two steps and a broken first install); a token without an organisation (rejected: breaks ADR-030 scoping).
- Change on acceptance: deleting the bootstrap cluster in Settings is final. Deleting any cluster keeps its token hashes in `retired_cluster_tokens`; the bootstrap does nothing for a retired hash or for a token the user revoked, so a restart with the same environment neither recreates the cluster nor re-enables the token (tests in `backend/test/cluster-bootstrap.test.ts`).
- Consequences: To connect the cluster again after deleting it, create a new cluster in Settings (or change the chart's token). The token never leaves the cluster except as a hash in PostgreSQL.

## ADR-070: Helm chart shape

- Date: 2026-10-31 · Status: accepted 2026-11-01 with one change (below)
- Context: ADR-059 fixed the two charts and official images; the details were open.
- Decision: (1) Migrations run as an init container of the backend (forward-only, idempotent; retried with backoff until PostgreSQL is up) instead of a hook Job, which would run before PostgreSQL exists on a first install. (2) PostgreSQL and VictoriaMetrics are single-replica StatefulSets with PVCs; the PostgreSQL password is generated once. (3) The chart does not label its namespace for PodSecurity; NOTES prints the command (docs/security.md). (4) The pod map certificate is generated by the chart (`genCA`/`genSignedCert`, 10 years, kept on upgrades), not by cert-manager. (5) Resource names: `<release>-…` in the server chart; the agent chart is `watchlog-agent` inside it (`fullnameOverride`). (6) Charts are installed from a repository checkout until images and charts are published (ADR-043).
- Alternatives: a migrate Job with `helm.sh/hook: post-install` (rejected: the backend would start before it and `--wait` would deadlock); cert-manager (rejected: an extra dependency for one internal certificate).
- Consequences: Upgrading the backend image migrates on the first new pod. Rotating the pod map certificate means deleting the Secret and upgrading.
- Change on acceptance: the Kubernetes install command shown in Settings creates the namespace and labels it itself (`kubectl create namespace watchlog && kubectl label namespace watchlog pod-security.kubernetes.io/enforce=privileged && helm install …`), so it works on clusters that enforce PodSecurity; the chart's NOTES keep the hint for installs from the chart alone.

## ADR-071: Kubernetes read API semantics

- Date: 2026-10-31 · Status: accepted 2026-11-01
- Context: SPEC §4.1 computes the health banner from firing alerts, which arrive in Phase 3; §4.1–§4.3 name tiles and columns without fixing their sources.
- Decision: (1) Until alerting exists, health is **critical** when the needs-attention list has a critical item (NotReady node, CrashLoopBackOff pod) and **degraded** with any warning (OOMKilled within the last hour, image pull failure, pod pending > 5 min, PVC > 85 %); `firingAlerts` is null. Phase 3 replaces this with alerts. (2) Overview usage without a namespace filter is the nodes' usage (`node.cpu.usage`, `node.memory.used`, system processes included); with a filter it is the selected namespaces' containers. Requests come from running pods' container specs; allocatable from the nodes. (3) Workload requests and limits are the pod template's (one replica), for the flat request line (ADR-056); pods are attributed to workloads by the cluster-agent's resolution (a CronJob's pods belong to the CronJob, not the Job). (4) A node's disk is `/`, else `/var`, else the fullest mount (kind nodes have no root filesystem series). (5) Events are paged newest first with an opaque cursor over (last_ts, involved_key, reason); markers are capped at 1,000 per request with `truncated`. (6) Namespace filters are comma-separated query parameters and become an escaped regex alternation in MetricsQL.
- Alternatives: a banner that says "no alerts yet" until Phase 3 (rejected: the first screen would answer nothing); usage as the sum of container series only (rejected: hides node-level pressure from system daemons).
- Consequences: On kind all nodes share the VM's /proc, so node CPU and memory are the VM's and identical across nodes (measured); real clusters are unaffected.
- Amended in slice 9 (measured in the acceptance runs): Kubernetes shows CrashLoopBackOff only while the container waits, so a container with three or more restarts whose last run failed within ten minutes also counts as crash-looping (the test pod otherwise flapped out of the list). `node.condition` counts conditions without a True series as 0 (only the current status has a series).

## ADR-072: Two alert rule kinds and the default rule mapping (Phase 3 D1)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Context: SPEC §4.7 lists 14 default rules. Some are Kubernetes or Docker state, others are usage thresholds.
- Decision: _State rules_ are evaluated from PostgreSQL (objects, heartbeats). _Metric rules_ run a query catalog expression as an instant query, isolated by `extra_label=cluster_id` (ADR-026). Mapping:
  - State: CrashLoopBackOff for 2 min (the ADR-071 crash-loop predicate); OOMKilled (a termination with reason OOMKilled in the last 10 min); Pending for 5 min; ImagePullBackOff/ErrImagePull for 2 min; Node NotReady for 1 min; node MemoryPressure/DiskPressure; Deployment ready < desired for 5 min; Docker container unhealthy; agent not reporting (no heartbeat for 3 min, per agent, including the cluster-agent).
  - Metric: node CPU > 90 % for 10 min; node disk > 85 % warning, > 95 % critical, per mount; PVC > 85 %; container CPU throttling > 25 % for 15 min; Docker container > 3 restarts in 10 min. Docker hosts get the host equivalents of the CPU and disk rules.
  - Service-to-service failed connections is defined but not evaluated before Phase 4 (eBPF).
- Alternatives: everything through VictoriaMetrics (rejected: termination reasons and conditions are exact in the objects and proven by the Phase 2 acceptance runs).
- Consequences: An evaluator that fails (VictoriaMetrics down) skips its rule for that cycle. It never reports "inactive", so outages do not resolve alerts.

## ADR-073: alert-worker process and leadership by advisory locks (Phase 3 D2)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01, with change E)
- Context: SPEC §5.1: a separate Node.js process evaluates rules every 30 s. Several replicas must never evaluate the same org at once.
- Decision:
  - `dist/alert-worker.js` from the backend image runs a cycle every 30 s.
  - Orgs are hashed into 64 buckets. Each replica holds `pg_try_advisory_lock` on the buckets it evaluates, and only those.
  - Live workers (ADR-088 heartbeats) share the buckets: each targets `ceil(64 / live workers)` and releases any surplus.
  - **Locks live on a dedicated connection outside the pool.** If that connection drops or fails its per-cycle check (`SELECT` on `pg_locks` for the session), the worker treats every bucket as lost, stops evaluating, reconnects with back-off and re-acquires on a later cycle.
  - State rows carry a version and are updated optimistically, so a worker that lost its lock mid-cycle cannot write a second transition.
- Alternatives: one Lease row with a TTL (rejected: failover waits for the TTL and needs clock care); Redis (optional in Community).
- Consequences: Failover takes one cycle after the session ends. A test terminates one worker's lock connection and checks that the second worker takes over without duplicate notifications.

## ADR-074: Notification outbox in PostgreSQL (Phase 3 D3)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Context: SPEC §5.1 names BullMQ on Redis, but Redis is optional in Community.
- Decision:
  - `notifications` is an outbox written in the same transaction as the state change. A unique `dedupe_key` per channel blocks repeats.
  - Every worker sends: rows are claimed with `FOR UPDATE SKIP LOCKED` and a 60 s lease.
  - Retries back off from 30 s, doubling up to 1 h, for at most 8 attempts. Permanent provider errors (400, 401, 403, 404, 410) fail at once.
  - The notification id goes to webhooks as `X-WatchLog-Delivery`, an idempotency key.
  - Each channel stores the last error for the UI.
- Alternatives: BullMQ (rejected: needs Redis); sending inline during evaluation (rejected: a slow provider would stall the cycle).
- Consequences: Delivery is at-least-once. A crash between the provider's 200 and the commit can repeat one message, but two workers can never send the same row.

## ADR-075: Alert identity and grouping (Phase 3 D4)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01, with change C)
- Decision:
  - An alert's fingerprint is rule + cluster + scope labels. The scope is the workload for pod rules (the pod itself when it has none), the node (and condition or mount) for node rules, the container for Docker, and the agent for heartbeats. A crash-looping Deployment stays one alert while its pods are replaced.
  - Transitions of one rule and cluster in one cycle become one message per channel, grouped by transition kind.
  - **A message lists at most 5 items, then "and N more" with a link to the alerts page.**
- Alternatives: the pod as the scope (rejected: every replacement pod would fire again).
- Consequences: One message per rule and scope (§4.7). A rollout that breaks 40 workloads sends one short message.

## ADR-076: Alert state machine (Phase 3 D5)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - One `alert_states` row per episode: pending → firing → resolved.
  - **Pending:** the condition is true but its duration has not elapsed. The duration counts from the time the data gives, when there is one (a node condition's transition time, a pod's creation), else from first sight. A pending episode whose condition clears is deleted without a message.
  - **Resolve:** the condition is false for 2 consecutive cycles, then a resolve message goes out. OOMKilled resolves 10 min after the last kill (ADR-072).
  - **Escalation:** a severity rise while firing (disk 85 → 95 %) sends a firing message again.
  - **Re-notify:** every `renotify_seconds` (default 4 h) while firing.
  - **Flapping:** a third episode firing within 30 min becomes _flapping_. It sends one flapping message, then nothing until the condition has been false for 15 min, then one resolve.
  - State is persisted, so restarts keep the timers.
- Alternatives: no hysteresis (rejected: noisy).
- Consequences: The state machine is a pure function, tested with a fake clock.

## ADR-077: Silences (Phase 3 D6)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - **Matchers:** a silence matches by equality on rule, cluster, namespace, workload, node and severity. Each silence has a start, an end, a creator and a comment.
  - **While silenced:** the alert is still tracked but sends nothing.
  - **On expiry:** if the alert is still firing when the silence expires, one firing message goes out.
  - **Resolve:** a resolve message goes out only if the firing message was sent.
- Consequences: No surprise resolves, and nothing is lost after a silence.

## ADR-078: Health banner from firing alerts (Phase 3 D7, supersedes ADR-071 item 1)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision: Overview health is critical if the cluster has any firing critical alert, degraded if it has any firing warning, else healthy. Silenced alerts don't count but are shown as "N silenced". `firingAlerts` is filled, and the needs-attention list stays as the object view. ADR-088 adds one more rule: health cannot be healthy while alerting is not running.
- Consequences: Implemented in slice 5. Until then ADR-071's derived banner stays.

## ADR-079: Channel secrets with AES-256-GCM (Phase 3 D8)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01, with change B)
- Decision:
  - **Encryption:** channel secrets (Slack URL, bot token, webhook HMAC secret) are encrypted with AES-256-GCM. The key is a 32-byte `WATCHLOG_SECRET_KEY` (base64 or hex). Ciphertexts carry a key id (`v1:`) for a later rotation.
  - **Start-up checks:** the backend and the alert-worker **refuse to start** if the key is missing or malformed, or if it cannot decrypt existing secrets. A canary is encrypted on first start; when no canary exists yet, every stored secret is tried. The error message names the problem and the fix.
  - **Key source:** a key is **never generated at runtime**. The Helm chart generates it once at install, kept across upgrades the way the DB password is. Compose requires it in `.env` (`openssl rand -base64 32`), like `WATCHLOG_DB_PASSWORD`. Development mode uses a fixed, published dev key, the same way it defaults `DATABASE_URL`. Cloud reads it from its secret manager.
  - **API:** secrets are write-only and shown as "set, …last 4".
  - **Docs:** docs/security.md and the Helm NOTES say to back up the key: without it the stored channel secrets are lost.
- Alternatives: a key generated at first start and stored in the database (rejected: the key would sit next to what it protects, and a lost volume would lose it silently).
- Consequences: Existing installs need the key before upgrading to Phase 3; the Helm chart adds it on upgrade.

## ADR-080: Alert channels (Phase 3 D9)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - **Slack:** incoming webhook with Block Kit and severity colour.
  - **Telegram:** the user's own bot token (Community). The chat is bound by a deep link `https://t.me/<bot>?start=<one-time code>`; the worker long-polls `getUpdates` only while a verification is open (10 min) and replies "Connected". Cloud later uses one shared bot with a webhook. The API base URL is configurable (`WATCHLOG_TELEGRAM_API_URL`), and outbound calls honour `HTTPS_PROXY`/`NO_PROXY`, because `api.telegram.org` is blocked on the owner's network.
  - **Email:** one SMTP server per install (`WATCHLOG_SMTP_URL`, `WATCHLOG_SMTP_FROM`, nodemailer), recipients per channel.
  - **Webhook:** versioned JSON, signed with `X-WatchLog-Signature: t=<unix>,v1=<HMAC-SHA256(t.body)>` using a per-channel secret, 10 s timeout.
  - **Send test:** each channel, synchronous, rate-limited, returns the provider's error.
- Consequences: Community needs no public URL.

## ADR-081: Alert message format (Phase 3 D10)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - **Firing:** three lines and a link. "🔴 CRITICAL · Pod CrashLoopBackOff", then "wl-test/web (Deployment) · cluster prod · since 12:04 UTC (5 min) · main: Error (exit 1), 6 restarts", then a link to the object page.
  - **Resolve:** "✅ RESOLVED · … after 12 min".
  - **Email subject:** `[CRITICAL] Pod CrashLoopBackOff — wl-test/web (prod)`.
  - **Links:** built from `WATCHLOG_PUBLIC_URL`. Without it, messages omit the link and Settings shows a warning.
- Consequences: What, where, since when and a link (§4.7), readable on a phone.

## ADR-082: Offline tests for alerting (Phase 3 D11)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - In Vitest, Slack, Telegram and webhook are in-process mock HTTP servers.
  - SMTP goes to Mailpit, a CI service container and a `compose.dev` service.
  - Nothing in tests or CI reaches a real provider.
  - Real Slack and Telegram delivery is a manual check, logged in the review notes when it cannot be done from here.
- Consequences: Deterministic CI. Telegram's real API (blocked here) is never needed.

## ADR-083: Alert rule storage (Phase 3 D12)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision: `alert_rules` holds:
  - `type`: `default` or `threshold`;
  - `rule_key`: for defaults, unique per org;
  - `metric`: a catalog key;
  - `scope`: jsonb;
  - `condition`: jsonb, `{op, value, critical?}`, where `value` raises the rule's `severity` and the optional `critical` raises critical;
  - `for_seconds`, `renotify_seconds`, `severity` and `enabled`;
  - `channel_ids`: uuid[];
  - `cluster_id`: null means all clusters of the org.
- Consequences: Matches §7. Defaults can be edited, not just toggled.

## ADR-084: Default rules for every org (Phase 3 D13)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - Every org has every default rule, enabled. The worker inserts any missing default (by `rule_key`) at the start of each cycle, which also covers existing orgs and defaults added in later versions.
  - Default rules can be disabled and edited but not deleted.
  - Until a channel exists they fire into the UI only. Adding the first channel offers "use for all rules" (on by default).
- Alternatives: a seeding migration (rejected: would duplicate the definitions in SQL and miss later additions).
- Consequences: Alerts work out of the box (§4.7). The failed-connections rule (Phase 4) has no evaluator yet and is therefore not seeded; it appears in every org once Phase 4 adds it.

## ADR-085: Custom threshold rule editor (Phase 3 D14)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01, with change D)
- Decision:
  - **Editor:** metric (catalog key) → scope (cluster / namespaces / workload / node / label selector) → condition → duration → severity → channels, with a preview chart that draws the threshold line.
  - **Label selector:** resolved at evaluation time to the matching pods from the objects. The pod names become an escaped `pod=~` matcher.
  - **Selector cap:** **at most 500 pods.** Beyond that, the API rejects the rule with a message suggesting a workload or namespace scope. If the selector grows past 500 later, the rule reports an evaluation error instead of a partial result.
  - **API:** accepts catalog keys and scope fields only, never MetricsQL (P1).
- Consequences: Implemented in slice 7.

## ADR-086: Phase 3 acceptance (D15)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision:
  - **Per rule:** one integration test per default rule triggers and resolves it. State rules run on fixtures with a fake clock; metric rules run against VictoriaMetrics.
  - **e2e on kind:** a CrashLoopBackOff pod, with all four channels pointing at mock servers and Mailpit, must produce exactly one firing and one resolve per channel. Resolve comes from deleting the pod.
- Consequences: Exactly SPEC §13, deterministic and offline.

## ADR-087: Alert history retention (Phase 3 D16)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Decision: Resolved alert states and finished notifications are kept 90 days (`WATCHLOG_ALERT_RETENTION_DAYS`, 1–400) and pruned by the worker once a day.

## ADR-088: Watching the watcher (Phase 3 D17)

- Date: 2026-11-01 · Status: accepted (owner, 2026-11-01)
- Context: If the alert-worker stops, alerting fails silently, and that is the worst failure an alerting product can have.
- Decision:
  - **Heartbeat:** every completed cycle writes the worker's last cycle time, version, held buckets and last error to `alert_worker_heartbeats`.
  - **Not running:** alerting counts as not running when no worker completed a cycle within 2 minutes. The API exposes this; the web then shows a critical banner "Alerting is not running" on every page, and overview health cannot be healthy.
  - **Probes:** the worker serves `/livez` (its cycle loop advanced within 2 min) and `/readyz` (database and lock connection up). The Helm chart uses them as liveness and readiness probes, and Compose as a healthcheck.
- Consequences: Worker side in slice 1, API and health rule in slice 5, banner in slice 6, probes in slice 8; each with tests.

## ADR-089: Implementation choices in Phase 3 slices 1–4

- Date: 2026-11-01 · Status: accepted 2026-11-01 except item 5, which ADR-090 replaces
- Context: Details the accepted ADR-072…ADR-088 left open, decided during the unattended run so it would not block.
- Decision:
  1. **Unknown is not resolved.** When an agent stops reporting, the alerts built from its last report stay firing, beside "agent not reporting"; they resolve only from new data, or when the object or cluster is deleted.
  2. **Disabling a rule** closes its open alerts without a message and drops pending ones.
  3. **Failed-connections rule** (Phase 4) is not seeded until it can be evaluated (ADR-084 note).
  4. **The Helm secret-key Secret survives `helm uninstall`** (`helm.sh/resource-policy: keep`). PostgreSQL's PVC survives too, so a reinstall would otherwise meet old secrets with a new key and refuse to start.
  5. _(Replaced by ADR-090.)_ **Delivery order:** one channel's messages are sent in creation order within a batch. A retried firing message can still arrive after a resolve that was due earlier.
  6. **Docker unhealthy** fires only for running containers.
  7. **Links** carry `?cluster=<id>`; the web has to select that cluster (slice 6).
  8. **Email** is plain text.
- Alternatives: (1) resolving alerts whose source went silent (rejected: a dead cluster would look healthy); (4) deleting the Secret with the release (rejected: a reinstall over the kept database would refuse to start).
- Consequences: No change to the accepted ADRs; each item is easy to revert.

## ADR-090: A firing message never arrives after its resolve (replaces ADR-089 item 5)

- Date: 2026-11-01 · Status: accepted (the owner's rule; the option for "both still queued" was delegated and is chosen below)
- Context: With retries, a firing message could be delivered after the resolve of the same alert.
- Decision: The sender checks the alerts' current state before every message.
  - A firing, escalated, re-notify or flapping message leaves out alerts already resolved; with none left it is **dropped** (status `dropped`). The alerts left out lose their link to that message.
  - A resolve message waits (without using an attempt) while a firing message of its alerts on the same channel is pending or in flight. It then goes out only for alerts whose firing message was delivered (ADR-077); with none, it is dropped.
  - **When the firing and its resolve are both still queued, neither is sent** (chosen over one combined "fired and resolved after N min" message).
- Alternatives: one combined message (rejected: it would announce a problem that is already over, and a short blip would still page; the alert stays in the history with its notifications marked dropped).
- Consequences: Tested in both orders: both queued; resolve due while the firing waits for a retry; resolve while the firing is in flight; a batched firing message partly resolved before sending.

## ADR-091: Implementation choices in Phase 3 slices 5–8

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Context: Details the accepted ADRs left open, decided during the unattended run so it would not block.
- Decision:
  1. **Health `unknown`.** While alerting is not running, overview `health` is `unknown`, unless a firing alert already says worse. It is not shown as "degraded". The banner explains it, and the "Alerting is not running" banner shows on every page (ADR-088).
  2. **Channel URLs:** Slack and webhook URLs may be any `http(s)` URL. Slack URLs are not limited to `hooks.slack.com`, so mocks, proxies and Slack-compatible receivers work. Cloud (Phase 5) has to add an egress policy against SSRF.
  3. **Permissions:** silences, rules and channels are changed by owners and admins; viewers read them.
  4. **Deleting a channel** removes it from every rule. Default rules cannot be deleted (409), only disabled.
  5. **Custom-rule metrics:** the editor offers 20 curated catalog metrics, 13 for Kubernetes and 7 for Docker. The API accepts any catalog key.
  6. **Kubernetes probes:** the alert-worker uses `/livez` (liveness, 30 s initial delay) and `/readyz` (readiness). Compose uses a `node -e fetch(…/livez)` healthcheck; for it, `node` is on PATH in the backend image.
  7. **SMTP in Helm:** the URL is stored in Secret `<release>-smtp`, and the backend and the worker share all alerting settings (`watchlog.alertingEnv`).
- Consequences: Each item is easy to revert. Item 2 must be revisited before Cloud.

## ADR-092: ComboBox on Reka UI (headless) for every select

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Context: Native `<select>` elements look plain and cannot be searched. The alerts redesign needs searchable pickers with groups, descriptions, multi-select and long lists (namespaces, workloads, nodes).
- Decision:
  - **Component:** one `ComboBox` component (`web/src/components/ui/ComboBox.vue`), built on **Reka UI 2.11** (the Vue port of Radix primitives).
  - **What Reka supplies:** only the ARIA combobox and listbox mechanics: focus, keyboard, `aria-*`, the positioned popover, and virtualisation through `@tanstack/vue-virtual`.
  - **What the component adds:**
    - styling with tokens, the same height and radius as inputs, and a `toolbar` variant for the top bar
    - filtering in our code (Reka's own filter is off), so it works with the virtualiser
    - chips for multi-select, a clear button, and a "No matches" state
    - virtualisation above 100 options
  - Every native `<select>` in the app is replaced: cluster switcher, rule metric, scope, condition, workload kind, Docker host and project filters, the events kind filter. The namespace filter's hand-made listbox is replaced too.
- Alternatives:
  - **Headless UI for Vue** (rejected: its Vue version is maintained less actively and has no virtualiser).
  - **Hand-written ARIA** (rejected: the combobox pattern has many keyboard and focus details that a maintained library already gets right).
  - **A styled component library** (rejected: it would bring its own styles and conflict with the design tokens).
- Consequences: About 30 kB gzipped added to the web bundle, loaded with the app shell. Reka's styling hooks (`data-highlighted`, `data-disabled`, `data-state`) are part of the component's contract.

## ADR-093: Settings made in the UI: public address, email server, Telegram proxy

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Context: The public address and the email server could only be set through environment variables, and Telegram had no way around a blocked network.
- Decision:
  - **Storage:** one `server_settings` table, one row per key (`general`, `smtp`, `telegram`), for the whole installation.
  - **Precedence:** an environment variable always wins (`WATCHLOG_PUBLIC_URL`, `WATCHLOG_SMTP_URL`/`_FROM`, `HTTPS_PROXY`). The API then answers 409 to changes and reports `source: env`; the web shows the field read-only with "Set by the server's environment". UI text never names a variable.
  - **Public address:** "Use this address" fills in the browser's origin. Alert links, install commands and the alerting status use the effective address. CSRF still trusts only the environment's address.
  - **Email server:**
    - Host, port, STARTTLS/TLS/None, username and sender. The password is encrypted with the secret key (ADR-079), write-only, and shown only as "ends in …xxxx", as the owner asked.
    - "Send test email" mails the signed-in user with the form's values (the stored password when left empty) and returns the server's own error.
    - Email channels only need recipients.
  - **Telegram:**
    - A proxy set in the UI applies to Telegram's calls only; the environment's proxy applies to every delivery.
    - `GET /settings/telegram/reachability` probes the Bot API.
    - Creating a channel that cannot reach Telegram answers with problem type `telegram-unreachable`, so step 1 says so instead of "bad token".
  - **Caching:** senders read the effective settings through a 10-second cache, so the worker picks up a change within 10 s.
- Consequences: A Compose install needs no restart to set up email. The "Telegram can't be selected" bug was unrelated: an unescaped `@` in a translation broke rendering. A test now compiles every message.

## ADR-094: One alert per silent cluster; held alerts

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Context: One silent cluster produced one alert per agent (6 firing for one cluster), and its other alerts kept firing or resolving on stale data.
- Decision:
  - **Silent cluster:** when every agent of a cluster or fleet is silent for 3 minutes (node agents of removed nodes excluded), the agent rule raises one alert for the cluster (fingerprint `cluster`). Its per-agent alerts are held. With only some agents silent, there is one alert per silent agent as before.
  - **Holding:** while the cluster is silent, its other rules are not evaluated, because the data is stale. Their open alerts are held: kept exactly as they are, neither notified nor resolved. No new alert is raised.
  - **NotReady nodes:** pod alerts whose pod's node is NotReady are held the same way, under the node alert.
  - **When data returns:** the hold ends and normal evaluation resolves the alerts (with a resolve message if a firing message went out) or keeps them firing.
  - **API and health:** `held` is a column on the alert. The API lists held alerts only with `?held=true` and counts them apart. Held alerts count neither as firing nor in cluster health.
- Alternatives: resolving stale alerts (rejected: a dead cluster would look healthy; see ADR-089 item 1); silencing them (rejected: silences are the user's).
- Consequences: Tested: all silent vs some silent, holding and release, pods on a NotReady node.

## ADR-095: Human alert text

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Decision:
  - **Facts:** evaluators store facts: last exit and code, restarts, memory limit, image, condition reason, probe output, threshold, mount.
  - **Templates:** `text.ts` makes a title and a "why" line per rule, the same for the API, the web, and Slack, Telegram, email and webhook. For example "payments-api is crash-looping" / "last exit: Error (code 1) · 9 restarts"; "Disk on worker-07 is 88% full" / "threshold 85% · rising 2% per hour · full in ~6 h".
  - **Read-time text:** the text is built when it is read, so relative times stay true and the stored rows do not change every cycle.
  - **Trend:** "Full in ~N" (disk and PVC) comes from `deriv` over the last hour. It is shown only when the rise is at least 0.5 points an hour and the disk would be full within a week, and it is rounded (hours above 2 h, else 10 minutes).
  - **Messages:** one alert's title is the message headline; a batch names the rule and the count, then each title.
  - **Older alerts:** alerts stored before this change fall back to the rule name and their old summary.
- Consequences: The e2e still matches the where line ("wl-alert/crashy (Deployment)"), which every message keeps.

## ADR-096: Rule editor drawer, one threshold model, preview backtest

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Decision:
  - **Editor:** one right-side drawer (a Reka dialog) for default and custom rules, as a sentence with ComboBox slots.
  - **Threshold model:** metric rules have one model, a warning threshold plus an optional critical threshold. They save `severity: warning`; a custom rule saved as all-critical opens with the critical threshold equal to the warning one. State rules keep a Warning/Critical choice.
  - **Preview:**
    - `POST /alert-rules/preview` replays a metric rule (saved or being edited) over the last 24 h at a 60 s step, with the worker's duration and resolve rules (2 clean checks). It returns how many times the rule would have fired, how many reached critical, and the busiest series.
    - For state rules it returns how often the rule fired in the last 7 days, from history.
  - **Rules view:** grouped rules as sentences. "Default rules send to" is shown once and set with `PUT /alert-rules/defaults/channels`. "Reset to default" calls `POST /alert-rules/:id/reset` (channels stay).
  - **Firing view:**
    - summary tiles, one card per silent cluster, alerts grouped by cluster
    - each alert's latest firing message per channel as ✓/✕, with the error on hover and for screen readers
    - a "Silence ▾" menu (1 h, 4 h, 1 day, 7 days, or with a comment)
    - "Silence…" for a cluster, severity, namespace, workload or node
  - **Top bar:** the time-range picker shows only on pages with charts (`meta.charts`).
  - **Advanced section:** shows the resolve and flapping behaviour as information; neither is a per-rule setting.
  - **Metric choices:** the custom-rule editor offers 20 curated catalog metrics; the API accepts any catalog key.
- Consequences: The editor has no raw MetricsQL (P1).

## ADR-097: Unmapped series come back once the pod map names them (refines ADR-049)

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Context: ADR-049 drops a container's series after a 60 s hold without a mapping. Given-up keys were forgotten only once the cgroup disappeared. Measured on kind: kube-proxy crash-looped (inotify limits after a host restart), the pod map was unreachable for longer than the hold, and every live container stayed without CPU and memory series until it restarted. Phase 2 acceptance failed 3 of 26.
- Decision: A given-up container or pod key is taken back as soon as the pod map names it; its samples from then on are sent normally (the held ones are already gone). `watchlog_agent_unmapped_containers_total` is not decreased, since it counts give-ups. Cgroups of uncaptured layouts (no pod UID) stay given up.
- Consequences: A pod map outage longer than 60 s leaves a gap in container series instead of a permanent loss. The cost is one map lookup per given-up key per scrape (BenchmarkCollect unchanged).

## ADR-098: Alert detail chart, rule snapshot and alerting periods

- Date: 2026-11-01 · Status: accepted (reviewed 2026-11-01)
- Context: The alert detail page showed only text. An alert that fired hours after its condition started (21:45 → 02:19 on a 0-minute rule) gave no reason. Heartbeat rows cannot explain it: they are deleted when a worker stops and pruned after a day.
- Decision:
  - **Chart:** `GET /alerts/:id/chart` charts the alert's object.
    - Window: from 2× the rule's duration (at least 30 min) before the condition started until it resolved or now. A longer time-range pick widens it, up to 30 days, and never narrows it.
    - Thresholds: the values the alert had, with a note when the rule changed since.
    - Markers: started, fired, resolved, silenced, each message (channel and status), OOM kills and last data.
    - Shaded: the firing period, earlier episodes of the same fingerprint, the times alerting was not running and an agent's silence.
    - At most 10 objects (the busiest), the rest counted.
  - **What each rule charts** (`rule-charts.ts`, next to the rule catalog): metric and custom rules chart their metric; each state rule has a defined chart (see the file header). The rule editor's state-rule preview returns the same chart for the rule's latest alert in the last 7 days.
  - **"One series per state" metrics** (pod phase, node condition, health): only the current state has a series, so at each step the state with the newest sample wins (`tlast_over_time`). A container waiting reason (ImagePullBackOff) wins over the phase where it has a sample.
  - **Agent rule:** "samples received per minute" is `sum_over_time(watchlog_agent_series[1m])`: each scrape reports how many series the agent sends. Measured in the dev data: 300–1,200 per minute for a kind cluster-agent.
  - **Rule snapshot:** `alert_states.rule_snapshot` (name, condition, duration, severity, metric, scope) is written whenever the engine writes the alert. A quiet firing alert keeps the values it fired with; the next state change records the current ones. It is null for alerts written before this change, which use the current rule.
  - **Alerting periods:** `alerting_periods` holds the periods when alerting ran. Every evaluated cycle extends the latest period, or starts a new one after more than 2 minutes (ADR-088's threshold). A gap is only claimed between two known periods, or as still open at the end. The migration backfills from the heartbeat rows still present. Periods are pruned with the alert history.
- Consequences: The detail page costs one more request, and two to four range queries per panel. Charts of alerts older than VictoriaMetrics' retention show the calm empty state.

## ADR-099: eBPF attribution, hooks and kernel aggregation (Phase 4)

- Date: 2026-11-01 · Status: accepted, including the implementation details (maintainer, review of the Phase 4 run)
- Context: SPEC §6.4 and §6.6 list hooks and capabilities; the owner fixed the approach before Phase 4.
- Decision (accepted):
  - Connections are attributed with `bpf_get_current_cgroup_id()` and the existing cgroup discovery (ADR-050). No hostPID, no SYS_PTRACE.
  - Capabilities: `BPF` and `PERFMON` only; `SYS_RESOURCE` only if measured necessary on older kernels, `NET_ADMIN` only if a socket filter needs it; each justified in docs/security.md.
  - Tracepoints are preferred over kprobes (`sock/inet_sock_set_state` for lifecycle, connect latency and failures; `tcp/tcp_retransmit_skb`); fentry/kprobes only where no tracepoint exists (bytes).
  - Counters are aggregated in per-CPU kernel maps keyed by (cgroup id, destination, port); user space reads and clears them every 15 s. No per-event stream unless measured necessary.
- Decision (implementation, accepted):
  - The tracepoints are attached as BTF raw tracepoints (`tp_btf`), and the bytes hooks as `fentry`. Neither needs tracefs mounted in the pod, both get typed arguments, and together they need no pt_regs, so one little-endian object serves amd64 and arm64. This needs kernel 5.5+ with BTF, which the 5.8+ requirement covers.
  - Attribution: the cgroup id is taken in process context, when the socket enters SYN_SENT inside `connect()`, and kept per socket in an LRU map. Later transitions (ESTABLISHED in softirq, CLOSE) and retransmits look it up by socket.
  - Draining: the aggregation maps are double-buffered. User space flips an index map, then drains and clears the inactive map, so no increments are lost between read and delete.
  - Scope: edges are observed on the client side only, so connections from clients outside the cluster to a workload are not edges in P0.
- Alternatives: kprobes on `tcp_v4_connect` (rejected: arch-specific pt_regs, unstable symbols); a per-event ring buffer (rejected by the owner unless measured necessary).
- Consequences: cgroup v1 nodes cannot attribute (the cgroup id is the v2 one) and report `ebpf: unsupported (cgroup v1)`.

## ADR-100: eBPF build: cilium/ebpf, bpf2go, committed objects (Phase 4)

- Date: 2026-11-01 · Status: accepted, including the container toolchain (maintainer, review of the Phase 4 run)
- Decision (accepted): `github.com/cilium/ebpf` with `bpf2go` and CO-RE; the generated objects and Go files are committed so normal builds need no clang; CI checks they are up to date; amd64 and arm64.
- Decision (implementation, accepted):
  - `make bpf` runs bpf2go in a pinned container (the Go build image plus Debian's clang). The same container in CI regenerates the objects and fails on a difference.
  - The C sources use a small hand-written set of CO-RE type definitions (`preserve_access_index`) instead of a generated vmlinux.h (about 7 MB), which keeps the repo small and works on every architecture.
- Alternatives: clang on the build host (rejected: CI and developers would get different objects).
- Consequences: changing a BPF source needs Docker; everything else needs only Go.

## ADR-101: Destination resolution and the cluster-wide IP map (Phase 4)

- Date: 2026-11-01 · Status: accepted, including the endpoint shape (maintainer, review of the Phase 4 run)
- Decision (accepted): destinations are resolved via the cluster-agent's pod map, extended with Services (ClusterIP, as seen before DNAT), headless Services and EndpointSlices. Externals by DNS name, else `/24` + port, collapsed into "Internet" beyond 50 per workload.
- Decision (implementation, accepted):
  - The cluster-agent serves `GET /v1/ipmap` with the same TokenReview authentication as the pod map (ADR-066). The map is cluster-wide, because destinations are anywhere in the cluster, and is sent with an ETag so unchanged maps are not re-sent; node agents refresh it every 15 s.
  - A ClusterIP resolves to its Service. When the Service's endpoints all belong to one workload, the edge points at that workload; otherwise it points at the Service.
  - Services and EndpointSlices are also ingested as objects for the topology-only fallback (ADR-103).

## ADR-102: Docker mode, DNS errors and kernel support (Phase 4)

- Date: 2026-11-01 · Status: accepted (owner decisions)
- Decision:
  - Docker mode runs the same programs; container IPs come from Docker inspect; the `docker run` command adds the capabilities.
  - DNS rcodes (NXDOMAIN, SERVFAIL, timeout) are read from the header and question only. No other payload and no TLS inspection, ever. (Extended by ADR-104: A, AAAA and CNAME answers may be read to name external edges.)
  - Kernels: 5.8+ with BTF. Otherwise the agent reports `ebpf: unsupported` with the reason, everything else keeps working, and the map falls back to "topology only" from Services/Endpoints, clearly labelled.
  - The failed-connections default rule (> 5 % for 5 min) is evaluated, with a chart definition for its alert page.

## ADR-103: Service map UI and the demo app (Phase 4)

- Date: 2026-11-01 · Status: accepted (owner decisions)
- Decision:
  - The graph is an ECharts graph (already shipped) unless it measurably fails at 50+ workloads; then Cytoscape.js with an ADR.
  - Edge health is never shown by colour alone. Each edge has a detail panel with time series; DNS errors and external dependencies are shown as in §4.5.
  - The demo app has 6+ services with images from Docker Hub or ghcr.io only (gcr.io and pkg.dev are blocked here), or tiny Go services built locally.

## ADR-104: External destinations named by the DNS answers the container received (Phase 4)

- Date: 2026-11-01 · Status: accepted (maintainer, review of the Phase 4 run: the "header and question only" rule of ADR-102 was too strict); the implementation details below accepted 2026-11-02
- Context: ADR-101 names externals "by DNS name". Mapping a destination IP to the name it was resolved from needs the answer records of DNS responses.
- Decision (accepted):
  - The agent may read the A, AAAA and CNAME answer records of DNS responses, only to map destination IPs to names for external edges.
  - Names are kept in agent memory with the record's TTL, capped at 10,000 entries. They are never stored and never sent except as an edge's destination name.
  - No other payload is read. Externals are named by DNS name, else `/24` + port (IPv6 `/48`), and "Internet" beyond 50 per source (SPEC §4.5).
- Decision (proposed — needs the maintainer's review):
  - **Kernel side:** for a NOERROR response with answers to a socket that sent a query to port 53, the program copies at most 512 bytes of the DNS message to a 256 KiB ring buffer. A full buffer drops the message, and the edge keeps its `/24` name. This is a stream of DNS responses only, not of connections (ADR-099). Names have variable length and compression pointers, so parsing them in the verifier is not practical.
  - **User space:** the parser reads the header, the question name and the answer records. It keeps the addresses of A and AAAA records under the question name, which is what the container asked for (the end of a CNAME chain belongs to it), and reads only the type of other records to skip them. Names are lower-cased and must be letters, digits, `-` and `_`; anything malformed is dropped. The message bytes are discarded after parsing.
  - **Map:** the key is (cgroup, address), so a shared CDN address is named by what each container looked up.
  - **Floor:** the TTL has a 60 s floor. Measured: Lima's DNS proxy answers with TTL 0 and CoreDNS on kind with TTL 5, both shorter than the 15 s between drains.
  - **Hold:** a name used by a connection is held for 10 minutes after its last use, so a long-lived connection's edge keeps its name. When full, expired entries go first, then the tenth closest to expiry.
  - **Cost:** about 2 µs per response including eviction (`BenchmarkNames`). Self-metric `watchlog_agent_dns_names`.
- Consequences: an external database appears as `db.example.com:5432` when the workload resolved it through DNS, and as `203.0.113.0/24:5432` when it connects by IP or resolved it before the agent started. DNS over TCP, DoT and DoH are not seen.

## ADR-105: eBPF agent runs as uid 0 with BPF and PERFMON only; BPF sources GPL-2.0 OR MIT (Phase 4)

- Date: 2026-11-01 · Status: accepted (maintainer, with the licence changed to dual GPL-2.0/MIT)
- Context:
  - SPEC §6.6 and ADR-060 run the node agent as uid 65532 with no capabilities. Measured on kernel 6.8 in Docker: as uid 65532 with `BPF` and `PERFMON` added, the process's effective capability set is empty, so map creation fails with EPERM. Linux gives added capabilities to non-root processes only as ambient capabilities, which Kubernetes cannot set.
  - The kernel accepts programs that use GPL-only helpers (`bpf_probe_read_kernel` and others) only when they declare a GPL-compatible licence; AGPL-3.0 is not on the kernel's list.
- Decision:
  - With `agent.ebpf.enabled` (the default), the node agent container runs as uid 0 with every capability dropped except `BPF` and `PERFMON`, `allowPrivilegeEscalation: false`, a read-only root filesystem, seccomp `RuntimeDefault`, no hostPID and no hostNetwork. With eBPF disabled it stays uid 65532 with no capabilities.
  - The BPF C sources (`agent/internal/ebpf/bpf/`) are `GPL-2.0-only OR MIT` and declare `LICENSE = "Dual MIT/GPL"`, which the kernel accepts as GPL-compatible. The MIT side means the object embedded in the agent does not conflict with AGPL-3.0 or the ee/ licence. Everything else stays AGPL-3.0-only; the generated Go bindings are excluded from the header check as before. Measured after the change: the programs load and attach with only BPF and PERFMON, in Docker on Ubuntu 24.04 (kernel 6.8) and in a kind pod.
- Alternatives:
  - File capabilities on the binary (rejected: they need `allowPrivilegeEscalation: true`, and the scratch image would need xattrs preserved).
  - `privileged: true` (rejected: everything).
  - GPL-2.0-only alone (the first proposal; changed by the maintainer: a GPL-only object inside an AGPL or ee/ binary is a licence question better avoided).
- Consequences: The pod is root inside its user namespace, without other capabilities. Measured: loads and attaches under Docker's default seccomp profile with `no-new-privileges`. Kubernetes (containerd `RuntimeDefault`) is measured in slice 1 on kind.

## ADR-106: Flow series, edge health and map details (Phase 4)

- Date: 2026-11-01 · Status: accepted (maintainer), except the namespace filter, changed as below
- Decision:
  - **Series:** per edge, cumulative counters built from the kernel deltas:
    - `watchlog_flow_connections_total`, `_connect_failed_total` and `_retransmits_total`;
    - `_bytes_total{dir=sent|received}`;
    - the `_connect_latency_seconds` histogram (12 buckets, 0.5 ms–1 s).
  - **Labels:** the source workload (`namespace`, `workload_kind`, `workload`) or Docker container (`container`, Compose project and service), and the destination (`dst_kind`, `dst_namespace`, `dst_workload_kind`, `dst_workload`, `dst_service`, `dst`, `dst_port`). No pod and no IP, except an aggregated external network. Edges idle for 10 minutes end.
  - **Unattributed traffic:** connections from processes outside containers (the kubelet's probes, host daemons) are counted in `watchlog_agent_flow_unattributed_connections_total`, not drawn. On kind every agent sees all nodes' connections because they share a kernel; each attributes only its own pods.
  - **Destinations:** a ClusterIP whose Service has exactly one workload behind it points at that workload, labelled with the Service. With several workloads, or none (scaled to 0), the edge points at the Service. Loopback is skipped.
  - **Health:** critical at ≥ 5 % failed (the default rule's threshold), warning at ≥ 1 % failed or p95 connect latency ≥ 1 s, idle without connections in the last 5 minutes. Rates are over the last 5 minutes; the time range picks which edges are shown and the edge detail's series.
  - **The failed-connections rule** needs at least 3 connections a minute on an edge, so one refused connection on an idle edge is not an outage.
  - **The namespace filter** shows an edge when either its source or its destination is in the selected namespaces (changed by the maintainer; first proposed: the source only). DNS errors are filtered by the workload that looked up.
  - **Docker mode** runs as `--user 0:65532` with only BPF and PERFMON; the image's data directory is mode 0770 (ADR-105).
- Open point (measured in the load test): a `connect()` that fails inside the kernel before any SYN is sent counts as a failed connection. The case seen was ephemeral-port exhaustion, EADDRNOTAVAIL with a client closing first at about 800/s on kind. Go's dialer retries those up to twice, so the application saw success while the kernel saw about 900 failed attempts a second. It is reported as is, since it is a real problem on the client; telling it apart from network failures would need a second hook.
- Consequences: An install made before Phase 4 has a data volume of mode 0755; the Docker command uses a new volume instead (ADR-107).

## ADR-107: Upgrades need no manual steps; why eBPF is off is shown with its fix (Phase 4)

- Date: 2026-11-01 · Status: accepted (the maintainer's requirement, review of the Phase 4 run); the key name and the Docker volume name accepted 2026-11-02
- Context:
  - On the owner's kind cluster the release `kind-demo` (chart before Phase 4, never upgraded) ran the old agent, which reported only `ebpf: disabled`; the map said "eBPF is turned off" without a reason.
  - The chart before Phase 4 shipped `agent.ebpf.enabled: false` as its default. `helm upgrade --reuse-values` hands the new chart the old release's computed values in place of the new defaults (measured with Helm 4.0.1 on kind), so the new default `true` never applied: the agent got `WATCHLOG_EBPF=false` and no capabilities. Marking new values (a version key) does not help the `watchlog` chart, because Helm still fills missing subchart keys from the new subchart defaults.
  - The `watchlog` chart's alerting values (Phase 3) were missing from such values, and rendering failed on nil maps.
  - A Docker install made before Phase 4 has a data volume of mode 0755 owned by uid 65532, which the new command's uid 0 without `DAC_OVERRIDE` cannot write; the agent exited.
- Decision:
  - **Upgrades never need manual steps.** A change that would need one ships an automatic migration instead. `deploy/test/helm/upgrade-test.sh` (CI) renders both charts from the computed values of a release before Phase 4 (`deploy/test/helm/pre-phase4/`), as `--reuse-values` does, and fails if eBPF is not on or any template fails.
  - **The opt-out is `agent.networkFlows.enabled`** (default `true`; for the `watchlog` chart `watchlog-agent.agent.networkFlows.enabled`). A missing key means on. `agent.ebpf.enabled` is ignored, and NOTES says so: before Phase 4 it did nothing.
  - Chart values added after the first release are read through defaults that keep set values, 0 and false included (`watchlog.withDefaults`).
  - **The Docker command's volume is `watchlog-agent-state`.** Re-running the install command creates it from the image (0770, group 65532); the old `watchlog-agent-data` is no longer used and can be removed.
  - **Why eBPF is off is reported as a code:** `ebpf_cause` is `config`, `kernel`, `permission` or `load`. A heartbeat without it comes from an agent before Phase 4 (`outdated`). The chart passes `WATCHLOG_HELM_RELEASE` (namespace/release) and `WATCHLOG_HELM_CHART`. Docker agents report their own container ID, read from their own `/proc/self/mountinfo`.
  - **The service map shows each cause with its fix:**
    - `config`, `permission` and `outdated` on Kubernetes: `helm upgrade <release> <chart> --namespace <ns> --reuse-values`, with `--set agent.networkFlows.enabled=true` for `config`; placeholders and `helm list -A` when the release is unknown.
    - The same causes on Docker: re-create the container under its own name, keeping its token, with the current command.
    - `kernel` and `load`: the reason and requirements, no command.
    - A notice also lists agents without eBPF when others have it.
- Consequences:
  - An explicit `agent.ebpf.enabled=false` from a Phase 4 build is not honoured. No such install exists outside this repository's tests.
  - Before 5.11 the kernel charges BPF maps to `RLIMIT_MEMLOCK`. EPERM there can mean a low memlock limit, and the reason says so.

## ADR-108: Connections open before the agent started are adopted on their bytes (Phase 4)

- Date: 2026-11-01 · Status: accepted (maintainer, 2026-11-02)
- Context: The agent learns a socket when it enters SYN_SENT (ADR-099), so a connection opened before the agent started (a DB pool, HTTP keep-alive) was invisible until it reconnected. Every agent upgrade or restart dropped such edges, measured on the owner's `kind-demo` after the upgrade: frontend → cart and cart → catalog were missing.
- Decision: When bytes flow on an unknown ESTABLISHED socket (`tcp_sendmsg`, `tcp_cleanup_rbuf`, both in process context), it is adopted if it is the client side: local port in Linux's default ephemeral range (32768–60999) and remote port outside it. The cgroup is the sending or receiving task's. An accepted server socket has the listening port as its local port and the client's ephemeral port as its remote one, so it is never adopted and no reversed edge appears. Adopted sockets count bytes and retransmits, not connects or connect latency.
- Consequences:
  - A connection between two ports inside the ephemeral range (a server listening on, say, 50051, which is in that range) is not adopted and appears only when it reconnects.
  - A node whose `ip_local_port_range` differs from the default is handled the same way: anything doubtful is skipped, never drawn backwards.
  - Measured on kind: both keep-alive edges reappeared within a minute of the agent restart, with bytes and 0 connects.

## ADR-109: Service map drawn with SVG and a particle canvas instead of the ECharts graph (Phase 4)

- Date: 2026-11-01 · Status: accepted (maintainer, 2026-11-02) (the redesign itself is approved)
- Context: The redesign needs things the ECharts graph series does not do together:
  - namespace group boxes;
  - positions kept per cluster and pinned by dragging;
  - particles along curved edges that follow dragging;
  - badges on edges;
  - fading everything but a node's neighbours;
  - zoom only with ⌘/Ctrl + wheel, while a plain wheel scrolls the page.

  ECharts' `lines` effect could animate particles, but only as a separate series that does not follow the graph's nodes. Every other item would need custom code around ECharts.

- Decision:
  - **Rendering (`ServiceMapCanvas.vue`):** SVG for group boxes, edges, nodes, labels and badges, which are clickable, focusable and testable in the DOM, with health on badges and pills, never by colour alone. A canvas on top draws the particles along the same quadratic curves, in one `requestAnimationFrame` loop with no DOM work per frame. With `prefers-reduced-motion` the particles stand still. ECharts stays for the edge's time-series charts. No new dependency.
  - **Layout (`servicemap-layout.ts`):** one band per namespace, columns by call depth (cycles broken from the uncalled nodes), externals in a column on the right. A node is placed when it is first shown and keeps its position: refreshes and filters never move it; new nodes go to free space near their namespace. Positions are kept per cluster in the browser (localStorage), dragged nodes are pinned, and "Reset layout" recomputes.
  - **Data:** refreshes every 15 s, without re-layout or skeleton.
  - **WatchLog's own components:** the backend marks them (image `watchlog-light/*` and their `<release>-postgresql|victoriametrics|…` siblings), and they are hidden with node-level destinations by default.
  - **Labels:** placed greedily by priority. Below 0.6× zoom, minor labels are hidden.
  - **Rates:** the map draws connections per second, which is what the kernel measures, not requests per second. Keep-alive edges move by their bytes.
- Measured (headless Chrome, 1600×1000, M-series Mac):
  - 200 nodes and 367 edges with particles: 60 fps, p95 frame 16.7 ms, no long tasks;
  - panning: 61 fps; dragging a node: 60 fps;
  - layout of 200 nodes / 400 edges: under 500 ms in the unit test.
- Consequences: Positions live in each browser: two people see the same layout only if they drag nothing. Moving positions into the database is possible later without changing the layout code.

## ADR-110: The overview's problems are one list, from alerts and objects (overview redesign)

- Date: 2026-11-01 · Status: accepted (maintainer, 2026-11-02) (the redesign is approved)
- Context: The old overview counted firing alerts in its banner ("5 alerts firing") but listed object problems under Needs attention (3 items). The same pod also produced two alerts (crash loop and OOM) and a BackOff event.
- Decision:
  - **One list:** `GET /clusters/:id/overview` builds one problem list (`backend/src/modules/overview/problems.ts`). The status strip, its chips and Needs attention all count it.
  - **Firing alerts first,** one item per object for pod-health rules. The most specific alert names the item (OOM over crash loop), the item takes the group's highest severity, and the other alerts count as "related".
  - **Then object problems no alert covers:** crash loops, OOM kills, image pulls, pending pods, NotReady nodes, full PVCs. Silenced alerts also cover them, since the user chose to mute them. One item per workload; a crash loop whose last exit was an OOM kill is named for the OOM.
  - **Health:** critical or degraded from the list. With an empty list it is healthy, or **unknown** while alerting is not running (ADR-088). A crash-looping pod is shown as critical even without a running alert-worker, since its object says so.
  - **Warning events:** grouped by object and reason, with pod UIDs stripped. They are flagged when their object (or its workload) is in the list, or is one of WatchLog's own pods; for pods that no longer exist this uses the controllers' naming. The page hides both kinds and says what it hid.
- Consequences:
  - Strip and list can no longer disagree.
  - The overview shows a problem whose alert is silenced only as part of the silenced count.
  - Measured: 100 nodes / 3,000 pods with an hour of series, p95 76 ms (`WATCHLOG_BENCH=1`); kind from the browser, p95 59–76 ms.

## ADR-111: Cluster pages: system namespaces, workload reasons from the alert rules, cluster-wide events (cluster pages redesign)

- Date: 2026-11-01 · Status: accepted (maintainer, 2026-11-02) (the redesign is approved)
- Context: The Workloads, Nodes and Events pages were redesigned. A few choices go beyond layout.
- Decision:
  - **System namespaces are a setting** (`GET/PUT /settings/namespaces`, Settings → General). Default: kube-system, kube-public, kube-node-lease, local-path-storage, plus the namespaces WatchLog runs in (detected as for the service map). The Workloads page and the overview's top workloads hide them by default; one switch shows them. A migration widens the settings key check (ADR-107: no manual step).
  - **A workload's reason line uses the alert texts** (ADR-095). A firing alert about it comes first. Otherwise its pods are matched with the alert rules' own matchers (`POD_MATCHERS`, now exported from `alerts/defaults.ts`) and worded by `alertText`, so the page says what an alert would say even with alerting off. Then missing replicas, a failed Job or CronJob run, and an HPA whose metrics fail (from its Warning events).
  - **Jobs a CronJob started are not rows**; the CronJob shows its schedule and its newest finished run.
  - **Cluster-scoped objects have no namespace.** Kubernetes stores node events in "default"; the API returns `namespace: null` for Node, PV, Namespace and other cluster-scoped kinds. The top bar's namespace filter excludes them; the Events page's facet has "cluster-wide" (`ns=-`).
  - **Events summary:** `GET /events/summary` spreads each stored event's count evenly over its first..last seen time, in at most 48 buckets. Facets leave out their own filter. Markers are drawn for reboots, NotReady, OOM and evictions.
  - **Grouping happens in the browser** (`web/src/lib/events.ts`): one reason on two or more objects of one kind and namespace within 10 minutes is one row. Routine node start-up events (Starting, NodeReady, NodeHas…) fold into one "reported healthy" row. Grouped pages load 300 events, ungrouped ones 100.
  - **Long lists are virtualised with `@tanstack/vue-virtual`** (lists over 200 rows). It was already in the lockfile through reka-ui at the same version, so no new release-age exception was needed.
  - **The overview heatmap draws a fair share per node:** every failing pod, then the same number per node, up to 2,000. Each node's own count is shown, with "+N".
  - **The kubelet TLS notice links to the FAQ in the repository** (`docs/site/faq.md`): there is no docs site yet.
- Consequences:
  - Measured on the 15,008-pod / 501-node kwok data with an hour of series per pod, server side, 20 runs each after warm-up:
    - workloads p95 219 ms; pods p95 158 ms; nodes p95 159 ms (174 ms with heatmaps); overview p95 155 ms;
    - events list p95 ≤ 10 ms; events summary p95 477 ms over 7 days of all types, 278 ms over the 3 h the data covers.
  - The pod list is 7 MB at 15,000 pods, so the Workloads level no longer loads it; the Pods level does.
  - Request and limit bars compare a workload's total usage with request × its running pods.
  - "Up" on a node card is the time since it last became Ready, since no boot-time metric exists; a reboot resets it.

## ADR-112: One selected cluster; Docker fleets get every page (Docker parity)

- Date: 2026-11-01 · Status: accepted (maintainer, 2026-11-02)
- Context: Each page picked its own cluster: the Docker page showed the fleet, every other page the first Kubernetes cluster. So choosing `my-cluster` and opening Overview switched back to `kind-demo`. Docker fleets also had one page of their own instead of the cluster pages.
- Decision:
  - **One selection.** `web/src/stores/clusters.ts` holds the selected cluster. Only the switcher changes it, or a link's `?cluster=`. It stays in the URL and is remembered per user in the browser. With nothing remembered, it falls back to the first Kubernetes cluster, else the first fleet. The Kubernetes and Docker stores read it and never fall back to another cluster.
  - **Navigation by kind.** Kubernetes: Overview, Nodes, Workloads, Events, Service Map, Alerts, Settings. Docker: Overview, Hosts, Containers, Events, Service Map, Alerts, Settings. A page of the other kind redirects to Overview (router guard). Old `/docker` links redirect.
  - **Docker pages reuse the Kubernetes components**, not forks:
    - Hosts map into the node model the Nodes components read (Docker version for the kubelet's, running containers for pods, no requests).
    - Containers are rows with a problem, grouped by Compose project like namespaces.
    - Bars, heatmaps, list virtualisation and grouping are shared.
  - **Docker events** are stored with the Kubernetes events (same partitions and retention, ADR-061), with a new `host` column. The agent maps Docker actions to reasons and messages. A container keeps one row per reason and day when it is re-created.
  - **Docker problems** use the alert texts (ADR-095): unhealthy, restarting, OOM-killed, or exited non-zero within a day.
    - An OOM kill counts only for a container that stopped. Docker keeps the flag on running containers after a process inside was killed.
    - Containers on a host that stopped reporting are left out; the host's alert covers them.
  - **Docker change markers** come from complete snapshots: re-created (`recreate`), image changed (`image`), Compose project up or down (`compose`).
  - **The service map** groups containers by Compose project. Without eBPF it draws Compose networks and their containers. The agent now sends user-defined networks in the inventory.
  - **Host and node uptime** use a new series, `watchlog_node_boot_time_seconds`, from `/proc/stat`.
- Consequences:
  - Two migrations: the events `host` column, and the marker kinds.
  - The agent sends Docker events (231 ns and 4 allocations per event; at most 2,000 queued). It also sends one more series per host and networks in the inventory.
  - Agents before this version send no Docker events, networks or boot time. Those pages show what exists; uptime falls back to Ready since on nodes and is left out for hosts.

## ADR-113: DNS search-path misses are counted apart from DNS errors

- Date: 2026-11-02 · Status: accepted (maintainer, 2026-11-02: the approach; the details below are proposed)
- Context: With `ndots:5`, a resolver tries `example.com` under each search domain before the name itself (`example.com.<ns>.svc.cluster.local`, `example.com.svc.cluster.local`, `example.com.cluster.local`, then the node's domains). Each try ends in NXDOMAIN, so a healthy client calling `example.com` showed most of its lookups as failed.
- Decision:
  - **The kernel copies NXDOMAIN responses too**, up to the end of the question (at most 272 bytes: the header, a 255-byte name, type and class). Responses with answers are copied as before (ADR-104). The agent reads only the question name.
  - **A search-path miss** is an NXDOMAIN whose question name ends in `.<search domain>`. The search list is the agent's own `/etc/resolv.conf`: in a pod, kubelet gives every pod on the node the same list apart from the namespace entry, which `svc.<cluster domain>` already covers; in Docker it is the host's.
  - **The agent reports misses as `watchlog_dns_requests_total{rcode="search_miss"}`** and leaves them out of `NXDOMAIN`. Per drain it takes at most as many misses as the kernel counted NXDOMAIN responses for that container. Misses read just after a drain wait for the next one and are dropped after two.
  - **The backend leaves misses out of the lookups and the error ratio**, and therefore out of the DNS problem flag on the service map. Each DNS row has its own `searchMissPerSecond`, shown as a muted line.
- Consequences:
  - A missing name looked up by its short name still counts as an error: the resolver tries the name itself last, and that NXDOMAIN is outside the search domains.
  - Limit: a missing in-cluster name looked up by its full name (for example `old-svc.shop.svc.cluster.local` after the Service was deleted) is under a search domain. It counts as a miss, not an error. The workload's connections to it still fail on the map.
  - Pods with a custom `dnsConfig` search list get the node's list. Their own domains count as errors, as before.
  - If the ring buffer is full, a miss counts as NXDOMAIN, as before this change.
  - Measured on kind (3 nodes, `ndots:5`, the node's search domain included): a client fetching `example.org` every 2 s shows 0.0 % failed lookups (1.3 lookups/s, 3.0 search-path misses/s); before, the same traffic read 70 % failed. A client looking up a name that does not exist still shows 67 %.
  - CoreDNS's own row counts the failures it forwards upstream for its clients, so a client's real NXDOMAIN shows on both.
  - Cost: about 180 ns and 3 allocations per NXDOMAIN response (`BenchmarkSearchMisses`).
  - Older agents send no `search_miss`; their NXDOMAIN counts as before. Older backends count `search_miss` as an error, which is the old behaviour. No migration is needed.

## ADR-114: The marketing site moves to a private repository; its docs stay public

- Date: 2026-11-06 · Status: accepted (maintainer, 2026-11-06)
- Context: The marketing site (watchlog.io: landing, pricing, legal pages, the Cloud waitlist form) was in `site/`, with its deploy files in `deploy/site/`. It is not part of the product: self-hosters never build or run it. Keeping it here made its copy, pricing and legal text part of the AGPL release, and forks would ship a copy of the project's own marketing. The user docs are different: self-hosters need them next to the code, in the same pull requests that change behaviour.
- Decision:
  - **The site, its tests, CI and deploy files (nginx config, deploy script, DEPLOY.md) move to a private repository.** `site/` and `deploy/site/` are removed here, and so are the `site` workspace package and the site's CI step.
  - **What users need stays public here:** the docs (`docs/site/*.md`), the README screenshots (`docs/images/`), the design tokens and logo (`packages/design-tokens/`) and the Docker install's `compose.yaml`.
  - **The site's build reads them from this repository at a pinned commit.** Locally it reads a checkout next to it; CI checks out the pinned commit; deploys take the pinned commit with `git archive`, so uncommitted local edits are never deployed. `/docs` and `/security` render the same Markdown as before, and the site's build fails when a file it needs is missing.
  - **The design tokens are copied at build time, not installed as a git dependency.** The build already needs this repository for the docs, so one pinned commit covers docs, screenshots and tokens, and they can't drift apart. A git dependency would add a second fetch at install time, with its own credentials while this repository is private and its own ref to keep in step. `packages/design-tokens` is also a workspace package, and pnpm handles a monorepo subfolder fetched from git less well than a file copy.
  - **`pnpm check:private` fails if site code comes back:** `site/` or `deploy/site/`, a `nuxt.config` or `site.config` file, a `package.json` that depends on Nuxt, or the private repository's name. `docs/site/` is allowed.
- Alternatives:
  - Keep the site here and only keep its content out (rejected: the copy, prices and legal pages are content).
  - Move the docs to the private repository too (rejected: self-hosters read them in the repository, and the README, the dashboard's help links (`web/src/lib/links.ts`) and the release notes link to `docs/site/`).
  - A git submodule of this repository in the site's repository (rejected: the same pin as a JSON file, with more steps for every clone).
- Consequences:
  - Renaming or moving a file in `docs/site/`, `docs/images/` or `packages/design-tokens/` breaks the site's build at its next pin bump. The commit that does it should say so (CLAUDE.md).
  - While this repository is private, the site's CI reads it with a read-only deploy key. Remove the key at launch.
  - The site's files keep their `AGPL-3.0-only` headers from when they were here. That is the maintainer's choice to make in the private repository and changes nothing here.
  - ADR-012 (Nuxt 4) still applies to the site, now in its own repository. SPEC §9, §11.4 and §12 are updated.

## ADR-115: An 11 px type step, for uppercase micro-labels and chart axis labels only

- Date: 2026-11-06 · Status: accepted (maintainer, 2026-11-06)
- Context: SPEC §11.2's scale starts at 12 px, and the Tailwind theme resets the default sizes (`--text-*: initial`). 13 web files still used a `text-11` class, which therefore set no size at all (the text inherited its parent's), and nine scoped style blocks hard-coded `font-size: 11px`. Small text had drifted into secondary values, chips, timestamps and legends.
- Decision:
  - **SPEC §11.2 adds 11 px for two uses only:** uppercase micro-labels (letter-spaced section labels such as the service map's filter and panel headings and the events facets) and chart axis labels (ECharts `axisLabel`, the events histogram's ticks). Everything else is 12 px or more.
  - **`--text-11` is in `packages/design-tokens/theme.css`**, so `text-11` and `var(--text-11)` now work. No raw `11px` is left in `web/src`.
  - **The audit moved the rest to 12 px:** timestamps, counts, chips, legends, metric captions ("used / requested"), the map footer and search hints, the panel's definition labels, chart marker and threshold labels, and the severity glyph.
  - **`web/test/design-tokens-guard.test.ts` enforces it:**
    - `text-11` only on an element that is also `uppercase`;
    - `var(--text-11)` only in an uppercase rule or the tick labels;
    - `fontSize: 11` only on axis labels;
    - no `font-size: 11px`.
- Consequences: the 11 px labels now really are 11 px, where they inherited 12–14 px before. Some captions grow by 1 px. Charts are unchanged apart from their marker and threshold labels.

## ADR-116: Cluster destinations are never external; the cluster-agent pushes IP map changes

- Date: 2026-11-06 · Status: accepted (maintainer, 2026-11-06)
- Context: The Phase 4 service map acceptance passed 8/9 on 2026-11-05. For several minutes after the demo app's Services appeared, the first connections showed as externals named from DNS (`x:cart.<ns>.svc.cluster.local:9898`) or as bare Service nodes. There were three causes:
  - **The node agent pulled the IP map** when it drained (at most every 15 s), and the cluster-agent cached it for 5 s, so a new Service could be unknown for a drain or two.
  - **The map named a Service's workload only from _ready_ endpoints**, so a Service whose pods were starting (or scaled to 0) had no workload.
  - **A destination missing from the map fell through to "external"**, named by the client's own DNS lookup.
    Once such an edge is in the 10-minute window, it stays on the map.
- Decision:
  - **Never external.** A destination whose DNS name is under `svc.<cluster domain>` is a Service: `<svc>.<ns>.svc…`, and for headless pods `<pod>.<svc>.<ns>.svc…`. The cluster domain comes from the node agent's search list (the `svc.<domain>` entry, default `cluster.local`). While the map does not know the address, the flow goes to that Service by name. A name under the domain that names no Service is dropped and counted (`watchlog_agent_flow_cluster_unresolved_connections_total`).
  - **The workload behind a Service, whatever its readiness.** The IP map uses, in order:
    - every endpoint, ready or not;
    - else the pods its selector matches;
    - else the Deployments, StatefulSets and DaemonSets whose pod template it matches.
      For that, the informer cache now keeps pod template labels.
  - **Push.** The cluster-agent rebuilds the IP map on every Pod, Service, EndpointSlice, Node and workload change: 200 ms after the first change, at most once a second. It answers `GET /v1/ipmap?watch=1` with `If-None-Match` only when the map changes (or with 304 after 50 s), and marks that support with `X-Watchlog-Watch`. Node agents keep one watch open and resolve each drain against the pushed map.
  - **Backward compatible.** An older cluster-agent answers at once without the header, and the node agent goes back to polling every interval. An older node agent never asks to watch.
- Alternatives:
  - A shorter poll interval (rejected: every node agent multiplies the load, and it only shrinks the window).
  - A Kubernetes watch from every node agent (rejected: needs list/watch RBAC on Services, EndpointSlices and Pods for the DaemonSet, against ADR-066's single cluster-agent).
  - Re-mapping `svc.cluster.local` externals in the backend for older agents (rejected: the edge-detail lookup matches the agent's labels, so the edge would lose its detail; agents and backend ship together in the chart, and old series age out of the 10-minute window).
- Consequences:
  - A new Service's edges appear correct from their first drain. `deploy/test/k8s/servicemap-latency.py` measures the delay from Service creation to a correct edge: on kind (3 nodes), 14, 22 and 36 s (median 22 s), with no wrong edge in any round. That is the client's next call plus the 15 s drain, remote write and the query. The service map acceptance passed 9/9 three runs in a row (it was 8/9). The demo app's edges appeared 15 s after its pods were ready (35 s before).
  - The cluster-agent keeps one encoded map, rebuilt at most once a second during churn. Each node agent holds one idle HTTPS request.
  - A Service with no endpoints and no matching pods or workloads is still drawn as a Service.
  - Connections refused while a dependency starts used to land on a separate Service or external node. They now count on the right edge. With a keep-alive client, which opens no new connections once it is up, the edge reads failed until they leave the 5-minute window (measured on kind: frontend → cart, 4 s of refusals, "100% failed" for 5 minutes while traffic flowed). Health therefore counts failures only while an edge had some in the last minute: the failed share stays over 5 minutes and is still shown, but an edge without a failure in the last minute is not red (amended 2026-11-06, owner's decision). A recovered keep-alive edge turns healthy about a minute after the dependency is up.

## ADR-117: Ingest failures are counted, recorded per cluster, shown and alerted on

- Date: 2026-11-06 · Status: accepted (maintainer, 2026-11-06)
- Context: Since the overview redesign, every objects delta with a new namespace failed with 500 (the `namespace` change-marker kind was not allowed). The cluster-agent retried the same delta every 5 seconds, which held back every later pod change until the next 10-minute snapshot. Nothing showed it: the CrashLoopBackOff alert simply didn't fire, and only the cluster-agent's debug log knew.
- Decision:
  - **Agents count failures.** Node agents, Docker agents and the cluster-agent count every failed ingest request by endpoint (write, heartbeat, objects, events) and HTTP status (`network` without a response), as `watchlog_agent_ingest_failures_total`.
  - **The backend records them per cluster.** Every answer of 400 or above to an authenticated agent is recorded in `ingest_errors` per cluster and endpoint, except 429 (backpressure) and 401 (no cluster). The record keeps when the failure began, the last status and message, and a count. The next success clears it; a success is checked against the database at most once a minute per instance.
  - **The UI says so.** A cluster counts as failing while it has an uncleared error from the last 10 minutes. The overview (in its one API call) and Settings (the cluster list and the cluster page) show "Data delayed: ingest failing since …", with each failing endpoint, its status and message.
  - **A default rule fires.** "WatchLog ingest failing" (`watchlog.ingest.failing`) is critical after 5 minutes, one alert per cluster. It is evaluated and never held, even while every agent of the cluster looks silent, because failing heartbeats are one way of looking silent. Existing installs get it through `ensureDefaultRules`, with no migration.
  - **The cluster-agent stops retrying the same delta.** After 6 failed deltas in a row (30 s), rejected or not delivered, it sends a fresh snapshot instead. If that fails too, the number of failures before the next one doubles, up to the 10-minute snapshot interval. A rejected delta chunk is now a failure, not a silent drop.
- Consequences:
  - A backend bug like the namespace marker shows within minutes: a banner, an alert, and a counter per status.
  - Failures the backend never sees (unreachable, a proxy's 502) show only in the agents' counters, and only once their metrics get through. The UI's banner covers what the backend answered.
  - One more table and one conditional update per minute per cluster and endpoint while ingest works.

## ADR-118: Processes wait for PostgreSQL on start instead of exiting

- Date: 2026-11-06 · Status: accepted (maintainer, 2026-11-06)
- Context: On a fresh install every pod starts at once. The alert-worker queried PostgreSQL before it accepted connections, or before the backend's migrate init container had created the tables, and exited. On kind it restarted 5 times, and the overview's first screen said "watchlog-alert-worker is crash-looping". That is not a first impression we want.
- Decision:
  - **Wait, don't exit.** The backend, the alert-worker and `migrate` wait for the database before doing anything else (`waitForDatabase`). They retry with a backoff from 1 s doubling to 10 s, and log "waiting for database" once and then every 30 s. Retries happen while PostgreSQL is not ready yet: refused, not resolvable yet, timed out, starting up (57P03), or its tables are not migrated yet (42P01).
  - **Misconfiguration fails at once:** a wrong password or a missing database exits as before, with the actionable message. So does still waiting after 5 minutes (`WATCHLOG_DB_WAIT_SECONDS`).
  - **Helm:** the backend and the alert-worker have a startup probe (6 minutes) that holds their liveness probes off while they wait, so Kubernetes counts no restart.
  - **Compose:** `migrate` already waited for a healthy PostgreSQL, and the backend and alert-worker for `migrate`. The backend now has a healthcheck, and `web` starts once it is healthy.
- Consequences:
  - A fresh install shows no restarts and no crash-looping WatchLog pod.
  - A database that never comes up is reported after 5 minutes instead of at once, which is still a crash, with the same message.

## ADR-119: Microsoft Clarity on the marketing site only, with consent; never in the product

- Date: 2026-11-07 · Status: accepted (maintainer, 2026-11-07)
- Context: SPEC §9.3 planned self-hosted Plausible or Umami for the marketing site. The maintainer wants session recordings and heatmaps of the site to see where visitors get stuck, and chose Microsoft Clarity. The product is self-hosted and promises that nothing leaves the user's infrastructure unless they configure it; the Cloud admin panel holds subscribers' addresses.
- Decision:
  - **Site only.** Clarity runs on watchlog.io: in the production build, on the canonical host, never in development or preview builds. The dashboard (`web/`), the agents, the backend and the Cloud admin panel never load it. `web/test/no-analytics-guard.test.ts` fails if "clarity" appears anywhere in `web/`.
  - **Consent first.** Nothing is requested from Microsoft until the visitor clicks Accept. Clarity's own "no-consent" mode was measured and not used: it keeps cookies off watchlog.io, but loading its tag lets Microsoft set third-party cookies on its domains before any choice. Accept loads the tag and grants analytics storage only (no ads). Decline, or no choice, means Clarity never loads; Decline after an Accept erases its cookies. A small bar with two equal buttons asks once; the choice is remembered and can be changed from the footer.
  - **Masking.** Every form field, including the waitlist email, is masked in recordings. The waitlist pages and any URL carrying a token never load it.
  - **CSP.** The site's CSP allows exactly the Clarity hosts it needs, in script-src, connect-src and img-src.
  - **Disclosure.** The site's privacy page says what Clarity collects, why, how to opt out, and that Microsoft processes it.
- Consequences:
  - SPEC §9.3 now names Clarity for the site, with these limits; UTM capture on signup is unchanged.
  - The site makes third-party requests to Microsoft; the product still makes none.

## ADR-120: The dashboard works on phones and tablets

- Date: 2026-11-07 · Status: accepted (maintainer, 2026-11-07)
- Context: An alert arrives on a phone, and the link opens the dashboard there. The layout assumed a desktop: below 768 px the sidebar shrank to an icon rail that couldn't switch clusters, wide tables scrolled sideways, and many controls were 20–36 px tall.
- Decision:
  - **Breakpoints:** 360, 390, 768, 1024 and 1280 px are tested. At 1024 px and above the layout is unchanged.
  - **Below 1024 px:** the sidebar is an off-canvas drawer behind a menu button, closed on every navigation. The cluster switcher moves into the top bar. Touch targets are at least 44 px; links inside running text are exempt, and a checkbox or radio counts through its label. Pod heatmap squares are too small to tap there, so they only show, and the node's row and the pod list lead to each pod.
  - **Below 768 px:** the cluster, the namespace or host filter and the time range share one sheet behind a button that shows the cluster and the range. Wide tables become stacked cards. Pickers (ComboBox) open as a full-width bottom sheet with their own search field. The rule editor is a full-screen sheet. The service map opens on Connections, with an "Open map" button; the map pans with one finger and zooms with two. Its nodes scale with the zoom, so they are exempt from the 44 px rule.
  - **Everywhere:** no horizontal page scroll; a code block, a table inside its card or a chart may scroll inside itself. Text is never below 12 px, except the 11 px uppercase micro-labels (ADR-115).
  - **Tests:** `pnpm -C web test:responsive` (Playwright, the installed Google Chrome) visits every route at each breakpoint against a running dashboard with data. It fails on horizontal page scroll, text under 12 px or a touch target under 44 px, takes screenshots at 390×844 and 768×1024, and checks touch pan and pinch on the map. It needs a dashboard with data, so it is not in CI.
- Consequences:
  - SPEC §11.3's app shell describes the drawer and the sheet.
  - New UI keeps to the same rules; the responsive suite catches regressions when it runs.

## ADR-121: Nothing of a shared host leaks: the eBPF pod filter, node metrics scope and node capacity

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context:
  - With kind or k3d each Kubernetes node is a container, and all nodes share the kernel of the machine they run on. The target is a production machine that also runs MicroK8s, plain Docker containers and other sites; nothing about that machine may appear in WatchLog.
  - **Flows.** The flow programs (ADR-099) ran for every task on the kernel. User space dropped flows whose cgroup is no known pod container (`watchlog_agent_flow_unattributed_connections_total`, ADR-106), so nothing reached the service map, but every connection and DNS query of the machine was recorded in the kernel's maps first, and on kind every node agent recorded the whole machine's traffic three times.
  - **Node metrics.** The host collector reads `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/diskstats` and `statfs`, which are host-wide whatever the node's namespaces: a kind node reported the machine's CPUs, memory, load, block devices, filesystem sizes and boot time.
  - **Capacity.** Kubernetes Node objects of kind and k3d nodes report the machine's capacity (measured: 16 CPU / 61 GiB on every node, whatever the node container's limits), and the UI showed it as each node's allocatable.
- Decision:
  - **The pod filter (Kubernetes mode, default on, `agent.networkFlows.podFilter`, `--ebpf-pod-filter`).**
    - Kernel: a `roots` hash map (cgroup id → 1, 16 entries), a `filter` array map (on/off) and a per-CPU `filtered` counter array. At the only three places the cgroup is taken in process context (SYN_SENT in `on_state`, `known_or_adopt`, `dns_query`), with the filter on, the event is recorded only if the current task's cgroup or one of its ancestors is in `roots`; otherwise it is counted (connections and DNS queries; adoption attempts are not counted, since they run on every send and receive) and nothing enters any map. Later hooks (ESTABLISHED, CLOSE, retransmits, bytes, DNS responses and the ring buffer) only look up sockets recorded there, so they need no check.
    - **Why a CO-RE walk:** `bpf_get_current_ancestor_cgroup_id()` is not allowed in tracing programs on the 5.8 minimum (SPEC §6.1). The walk reads `bpf_get_current_task()->cgroups->dfl_cgrp`, compares `cgrp->kn->id` with the map and moves to `cgrp->self.parent` (`self` is struct cgroup's first member), at most 16 levels. `kn->id` is what `bpf_get_current_cgroup_id()` returns and the cgroup directory's inode, the key user space already uses (ADR-099); measured equal on kernel 6.10 (`TestKernelPodFilter`, privileged container on Docker Desktop: a task one cgroup below a root is recorded under its own directory's inode) and on kernel 6.8 (kind on Ubuntu 24.04, `isolation-test.sh`). The verifier accepts the walk on both; 5.8 itself was not available to test.
    - User space: the roots are the inodes of the node's kubepods cgroups (`kubepods.slice`, `kubepods`, kind's `kubelet.slice/kubelet-kubepods.slice`), found where `PodContainers` looks. They are looked up again every interval (the kubelet may start after the agent); a scan that finds none keeps the last roots. The filter turns on only once a root is known, so an agent never records nothing by mistake. Docker mode is unchanged (no filter).
    - Self-metrics: `watchlog_agent_flow_pod_filter` (0/1), `watchlog_agent_flow_filtered_connections_total`, `watchlog_agent_dns_filtered_queries_total`; also `watchlog_agent_dns_unattributed_queries_total` for the user-space drop of DNS stats, which was silent.
    - The user-space drop stays as defence in depth (unit test: an unknown cgroup gives no edge and no DNS series, only the counters).
  - **Node metrics scope (`agent.nodeMetricsScope`, `--node-metrics-scope`, `WATCHLOG_NODE_METRICS_SCOPE`: `host` | `cgroup` | `auto`, default `auto`).**
    - `cgroup` reads the root of the cgroup namespace the agent sees (`<sys>/fs/cgroup`, the node container's cgroup):
      - CPU count: `cpu.max` quota / period, else the size of `cpuset.cpus.effective`, else the kernel's count. CPU seconds: `user` and `system` from `cpu.stat`, and an `idle` counter that grows by (cores × elapsed − usage) between scrapes and never backwards, so the backend's CPU % (non-idle over all modes) is usage over the limit. The first value is (cores × time since the node started − usage), so an agent restart continues about where it was.
      - Memory: total is `memory.max`; when it is `max`, the machine's `MemTotal`, and the agent logs it. Available is total − (`memory.current` − `inactive_file`), the working set as for containers; free is total − `memory.current`; cached is `file`. The backend's used = total − available is unchanged.
      - No load average (host-wide). Boot time is the node container's start: the kernel's `btime` plus `/proc/1/stat` start time of the node's PID 1 (neither is sent on its own).
      - Disks: `io.stat` summed over devices with `dev="all"`; no device names, no filesystem sizes (statfs of the node's mounts gives the machine's disks). The disk usage column and the disk usage rule stay empty for such nodes; documented.
      - Network: unchanged, `/proc/1/net/dev` of the node's network namespace (the node container's interfaces; `lo` and `veth*` skipped).
    - `auto` picks `cgroup` in node mode when the node looks like a container: `/.dockerenv`, `/run/.containerenv` or `/kind` in the node's root filesystem, or a cgroup v2 root that has `cpu.max` or `memory.max` (only non-root cgroups have them, so the node runs in a cgroup namespace below the kernel's root: a container or an LXC guest). Only files are read; never another process's environment. A Docker host's `auto` is `host`. `cgroup` without cgroup v2 falls back to `host` with a warning.
  - **The capacity rule.** The heartbeat carries `node_scope` and, in cgroup scope, `node_cpu_cores` and `node_memory_bytes` measured by the agent. When a node's agent reports `node_scope: cgroup`, the backend uses those as the node's capacity everywhere the UI shows it: the nodes list, the node page and the overview's CPU and memory totals and node cards (`nodeCapacity()` in `kubernetes/views.ts`). Otherwise the Node object's allocatable is used as before. Pods capacity still comes from the Node object.
  - Host names: the node agent's name is `NODE_NAME` (the Node's name, i.e. the node container's name on kind); the machine's host name is never read in Kubernetes mode.
- Cost (measured on a Lima VM, Ubuntu 24.04 arm64, kernel 6.8, 4 vCPUs; kind with 3 nodes, so 3 node agents attach their programs to the one kernel; the demo app running; a Python process on the VM making about 870 TCP connections a second to a local listener plus 100 DNS queries a second; per-program cost from `kernel.bpf_stats_enabled` and `bpftool prog show`, summed over the 3 agents; 60 s per phase):

  |                                                                 | filter on             | filter off                                                        | no agent        |
  | --------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------- | --------------- |
  | node agents' CPU, all 3 together                                | 0.60–0.72 % of a core | 1.63 % of a core                                                  | —               |
  | `on_state` (≈ 30 calls per outsider connection across 3 agents) | 142–168 ns/call       | 190 ns/call                                                       | —               |
  | `on_dns_send`                                                   | 519–679 ns/call       | 507 ns/call                                                       | —               |
  | `on_dns_recv`                                                   | 305–365 ns/call       | 3,521 ns/call (host NXDOMAIN responses copied to the ring buffer) | —               |
  | connect loop at full speed, 3 × 15 s                            | 15,669–16,677/s       | 15,841–16,249/s                                                   | 15,730–16,717/s |
  - The walk costs less than the map updates it saves: per outsider connection the three agents' `on_state` time drops from about 5.7 µs to about 4.5 µs, and the agents no longer drain, attribute and drop the host's flows and DNS responses in user space (agent CPU halves). A host DNS lookup no longer costs a 512-byte ring-buffer copy per agent.
  - The connect loop's throughput is the same in all three phases within run-to-run noise (about ±3 %): at 16,000 connections a second the client, not the hooks, is the limit, so the hooks' total (a few µs per connection, as above) is the better measure.

- Alternatives:
  - `bpf_get_current_ancestor_cgroup_id()` (rejected: not available to tracing programs on the minimum kernel).
  - A per-cgroup verdict cache in the kernel (rejected for now: with the walk the hook is already cheaper than without the filter, 142–168 vs 190 ns per call; a cache would hold host cgroup ids in the kernel and need invalidation when roots change).
  - Only the user-space drop (rejected: host traffic was still recorded in the kernel's maps, three times on kind).
  - LXCFS-style reading of `/proc` through the node's view (rejected: not present on kind or k3d nodes, and not every runtime offers it).
  - Correcting capacity in the cluster-agent from the Node object (rejected: the API server reports the machine's capacity; only the node's own agent can measure its limits).
- Consequences:
  - On kind, k3d or LXC nodes the service map, DNS rows and node pages show only the cluster; a process or container next to the cluster never appears and is only counted.
  - A node in cgroup scope has no load average, no filesystem sizes and no per-device disk I/O.
  - Upgrades need nothing: both values are read nil-safe (`deploy/test/helm/upgrade-test.sh` checks old values give the defaults); an older backend rejects heartbeats with the new capability fields (`additionalProperties: false`), which ships together with the agent in the chart.
  - The BPF builder takes `DEBIAN_MIRROR` (empty in CI) where `deb.debian.org` is unreachable; the builder reproduced the committed objects bit for bit before the change.

## ADR-122: A read-only demo mode, for a public demo of a sample cluster

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: The launch needs a live demo (demo.watchlog.io) where anyone can click through a real dashboard with a sample cluster, without signing up or installing anything. A normal installation can't be shared that way: every visitor would need an account, and an admin's session could change rules, channels and tokens, or read alert channel targets. Hiding buttons doesn't make it safe; the server has to refuse.
- Decision:
  - **One switch.** `WATCHLOG_DEMO_MODE=true` on the backend (the Helm value `demoMode`, default `false`, read nil-safe per ADR-107; `WATCHLOG_DEMO_MODE` in the Compose file). Only the backend reads it. The alert-worker, the web image and the agents are unchanged.
  - **Passwordless viewer sessions.**
    - `POST /api/v1/demo/session` signs the visitor in as one shared viewer account, `demo@watchlog.invalid` (`.invalid` is reserved, RFC 2606). It answers 404 when demo mode is off.
    - The account is made, or put back to a viewer, at start, in the installation's org. If there is no org yet, demo mode creates the default one, so the Helm bootstrap cluster has an org to join.
    - The account's password hash isn't an argon2 hash, so password sign-in always fails. `POST /auth/login` is refused in demo mode anyway.
    - **Demo sessions are stateless:** a cookie `wl_demo.<issued>.<expires>.<HMAC-SHA256>`, signed with a key derived from `WATCHLOG_SECRET_KEY` (HKDF, its own label). There is no database row, so visitors cost nothing to keep and nothing has to be cleaned up. A demo session ends 2 hours after the last request: it is renewed at most every 10 minutes. Sign-out clears the cookie; a copied cookie stays valid until it expires, which a read-only viewer session can afford. Out of demo mode a demo cookie is refused (401). We chose this over short-lived rows plus periodic cleanup because rows need a cap, a cleanup job and a decision about which visitors to drop under load; a signed cookie needs none of them.
    - The cookie has the normal session's name and attributes (HttpOnly, SameSite=Lax, path /), and Secure by the same per-request rule as the normal session cookie (ADR-123): over https, from the socket or a trusted proxy's `X-Forwarded-Proto`.
    - Starting a demo session is rate-limited to 20 a minute per visitor; a visitor with a valid demo cookie keeps it.
    - The account doesn't count as a user for first-run setup. Setup can still run after demo mode is turned off, and it joins the demo's org. At a start without demo mode, every demo session is ended.
  - **Every change is refused in one place.** An `onRequest` hook (`backend/src/plugins/demo.ts`) answers 403 to any request that isn't GET, HEAD or OPTIONS, for every user including admins and anonymous callers. It runs before authentication, rate limits and body parsing. The answer is an RFC 9457 problem: type `urn:watchlog:problem:demo-read-only`, and as `detail` the message "This is a read-only demo. Install WatchLog to try this on your cluster." It also carries `code: "demo_read_only"` and that text as `message`. It goes by the route pattern and lets through only:
    - `POST /api/v1/demo/session`: starts a demo session;
    - `POST /api/v1/auth/logout`: ends the caller's own session;
    - `POST /api/v1/query/range`: a read; chart queries are POSTed for their JSON body;
    - `/ingest/*`: the agents' token-authenticated writes. Agents also call the cluster-agent's `/v1/ipmap` and `/v1/podmap`, but those are served by the cluster-agent, not the backend.
  - **Queries stay small (demo mode only):**
    - every `range`, `from`/`to` and `step` a request can carry, in its query string or JSON body, is checked in one hook: at most the last 24 hours (400 "The demo shows at most the last 24 hours."), and at most 1,000 points per series for an explicit `step` (400). The UI drops its 7-day choice in the demo. An alert's chart spans at most a day.
    - one rate limit per visitor, 120 requests a minute, is shared by every route that queries VictoriaMetrics (`POST /query/range`, the cluster pages, the alert chart). Above it the answer is 429 with `Retry-After`. 120 rather than 60 because one page load issues up to about 10 such requests.
    - each VictoriaMetrics query from the API is aborted after 10 s (15 s otherwise).
    - the chart's `victoriametrics.extraArgs` (list or map, unset by default) lets the demo set VictoriaMetrics' own limits (`-search.maxQueryDuration`, `-search.maxUniqueTimeseries`, `-search.maxConcurrentRequests`).
  - **Per-visitor limits need the visitor's address.** Caddy also replaces `X-Forwarded-For` with its own peer, so behind a proxy in front of Caddy every visitor has the same `request.ip`. That also affects the existing sign-in and setup limits. `WATCHLOG_CLIENT_IP_HEADER` (Helm `backend.clientIpHeader`, unset by default) names a header the front proxy sets to the visitor's address, e.g. nginx's `X-Real-IP`, which Caddy passes through. Every rate limit keys on it when it holds an IP address and comes from a trusted proxy (ADR-123). Set it only when the front proxy always overwrites that header.
  - **Configuration without the API: a seed file.** `WATCHLOG_SEED_FILE` (Helm `seed`, rendered to a ConfigMap mounted read-only, with a checksum annotation that restarts the backend on change) holds alert rules in the shape of `POST /alert-rules`. The cluster is given by name or id, or null for every cluster. There are no channels, so nothing secret goes in.
    - At every start, after the bootstrap cluster, each rule is created if the org has no threshold rule with that name. A rule is never overwritten, so edits survive and a changed rule needs a new name. The work runs under an advisory lock, so several replicas apply it once.
    - A rule that can't be created (unknown metric, unknown cluster, invalid scope) is logged and skipped. An unreadable or invalid file stops the backend at start with the path and the problem.
    - With no org yet, it waits and is applied when first-run setup completes.
    - It works with or without demo mode. It is how the demo gets its rules, and demo mode never has to be turned off.
  - **GETs with side effects are refused too:** `GET /settings/telegram/reachability`, which calls the Telegram Bot API on every request. `GET /alert-rules` still writes missing default rules (`ensureDefaultRules`), which is the server's own idempotent seeding, not a visitor's change.
  - **No secret-adjacent data in demo mode:**
    - the cluster page lists no tokens, not even prefixes;
    - `GET /settings/smtp` answers `null`;
    - the Telegram proxy answers none;
    - alert channels show only type, name, rule count, times and whether a Telegram chat is connected: no recipients, URLs, bot or chat names, secret endings or last errors;
    - alert deliveries and notifications have no error text.
  - **In every mode, a URL never shows a password.** The Telegram proxy and the webhook URL hide a password in the userinfo, and the values of query parameters whose names look secret (token, key, secret, signature, …), behind `****`. Saving the proxy form unchanged keeps the stored password. Before this change, any signed-in user, viewers included, could read a proxy password that had been set in the UI or through `HTTPS_PROXY`.
  - **The web:**
    - `GET /setup` now also returns `demoMode`, and `required` is false in demo mode.
    - The sign-in page shows one "Enter live demo" button instead of the form. `/` and every page lead there for anonymous visitors, and `/demo` enters at once, for links from the site.
    - Every page has a banner: "Live demo · sample cluster · Install yours in 5 minutes →", linking to https://watchlog.io/docs/install/.
    - The controls that change something are hidden: `canManage` is false in demo mode whatever the role, and the cluster page has no token section. Sign-out stays.
    - A 403 `demo_read_only` from any call shows as a toast, a new `Toast` component (SPEC §11.3).
    - Nothing in demo mode loads analytics or makes a request to a third party (ADR-119).
- Alternatives:
  - A normal installation with a published viewer password (rejected: one shared password gets changed or locked out, and a viewer still saw channel targets).
  - Hiding the controls only (rejected: the API stays writable).
  - One session token for every visitor (rejected: one visitor's sign-out would sign out everyone).
  - Read-only per role, using the existing viewer role alone (not enough: an admin session on the demo server could still change everything; demo mode refuses for every role).
  - A separate demo build of the web with fixture data (rejected: it would drift from the product; the demo should be the real thing on a real cluster).
- Consequences:
  - Running the demo takes no write access. Its rules come from the seed file, so demo mode is never turned off. While it's on, no admin can sign in.
  - `backend/test/demo.test.ts` registers every route and checks that each non-GET route outside the allowlist answers 403 with the code and message, for an admin, a demo visitor and an anonymous caller. A new changing route is refused without anyone having to remember it.
  - `web/e2e/demo.spec.ts` checks the demo end to end against `WATCHLOG_DEMO_MODE=true pnpm dev`, and skips otherwise. `pnpm -C web test:responsive` takes `WATCHLOG_E2E_DEMO=true` and then enters through the demo instead of a password.
  - Demo visitors add no database rows. Rotating `WATCHLOG_SECRET_KEY` signs every demo visitor out.
  - `backend/test/demo.test.ts` also covers ingest. Every `/ingest/*` route answers 401 without a valid cluster token, whatever cookie comes with it (a demo cookie, an admin's session), in both modes.
  - The normal session cookie's Secure attribute is decided in ADR-123.
  - SPEC §8.1 gains `POST /demo/session`. SPEC §11.3's Toast now exists in `web/src/components/ui/ToastHost.vue`.
- Amended 2026-11-08 (release 0.2.0): demo mode blanks `kernelVersion` in every JSON answer, and with it in the REST API and MCP. A demo's nodes may share their host's kernel, whose exact version reveals the host's patch level.

## ADR-123: Trusted proxies decide the visitor's address and the session cookie's Secure attribute

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: Measured with caddy 2.11, as in the web image: Caddy replaces `X-Forwarded-For` with its own peer and `X-Forwarded-Proto` with its own scheme (http), and passes `X-Real-IP` through unchanged. With nginx, an ingress or Cloudflare terminating TLS in front of Caddy, the backend therefore saw every visitor at the same address and every request as http:
  - the per-IP rate limits (sign-in, setup, the demo's session and query limits) were effectively global;
  - the session cookie was never Secure (`request.protocol === 'https'`).

  ADR-122's `WATCHLOG_CLIENT_IP_HEADER` fixed the address, but trusted the header from any peer.

- Decision:
  - **A trust list.** `WATCHLOG_TRUSTED_PROXIES` (Helm `backend.trustedProxies`, nil-safe; Compose passes it through) lists comma-separated CIDRs or addresses. The default is loopback and private ranges (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), which covers the web container in Compose and Kubernetes. The backend judges the socket's peer address (an IPv4-mapped IPv6 address counts as IPv4). An invalid entry stops the backend at start.
  - **The visitor's address** (`plugins/client-ip.ts`, used by every rate limit):
    - with a client-IP header configured and a trusted peer, the header's first value if it is an IP address;
    - from an untrusted peer, the socket address, so a client that reaches the backend another way cannot pick its bucket;
    - with no header configured, unchanged (`request.ip`).
  - **The session cookie's Secure attribute is decided per request.** `WATCHLOG_COOKIE_SECURE` (Helm `cookieSecure`, nil-safe; Compose passes it through) is `auto` by default. Under `auto`:
    - Secure when the socket is TLS, or a trusted peer sent `X-Forwarded-Proto: https` (first value);
    - otherwise not, so plain-http installs (LAN, local development) keep a cookie they can use.

    `always` and `never` override. The same rule applies to sign-in, setup, sign-out and the demo cookie (ADR-122), replacing the demo's "Secure unless `NODE_ENV=development`".

  - **The web image's Caddy trusts private ranges** (`servers { trusted_proxies static private_ranges }`), so a TLS proxy's `X-Forwarded-Proto` reaches the backend. Measured: `X-Forwarded-Proto: https` and `X-Real-IP` pass through. `X-Forwarded-For` keeps Caddy's own peer, as before, by `header_up X-Forwarded-For {remote_host}` on both `/api` and `/ingest`. Without that header_up, Caddy appends the client's own `X-Forwarded-For`, and the backend's `request.ip` (trustProxy) would take the client-supplied leftmost address. Caddy logs that this header_up is "unnecessary"; measured, it isn't.
- Alternatives:
  - Secure whenever `WATCHLOG_PUBLIC_URL` is https (rejected: it breaks sign-in for anyone who opens an https-configured install over plain http).
  - Fastify's `trustProxy` with a CIDR list instead of `true` (not enough: Caddy still overwrote `X-Forwarded-Proto` and `X-Forwarded-For`, and the visitor's address arrives in `X-Real-IP`, which `trustProxy` doesn't read).
  - Trusting the client-IP header from any peer (ADR-122's first version; rejected: spoofable when the backend is reachable other than through the proxy).
- Consequences:
  - Behind a TLS proxy that sets `X-Forwarded-Proto` (the demo's nginx does), session cookies become Secure with no configuration. Existing sessions get the attribute at their next sign-in.
  - A client on a private network that connects to Caddy directly can send `X-Forwarded-Proto: https` and get a Secure cookie over http, which only breaks its own sign-in. It cannot choose its address: `X-Forwarded-For` stays Caddy's peer, and the client-IP header is off unless configured.
  - With `WATCHLOG_CLIENT_IP_HEADER` set, anyone who can reach Caddy without passing the front proxy can name any address, because Caddy itself is a trusted peer. Set the header only where the front proxy is the only way in. For the demo, Caddy is published on 127.0.0.1 behind nginx.
  - Docs: `docs/site/configuration.md` gains "Behind a reverse proxy".
  - Tests:
    - `backend/test/proxy.test.ts`: trusted and untrusted peers, separate buckets per visitor behind a trusted proxy, one bucket per untrusted peer, and `auto`/`always`/`never` for unit and end-to-end cookies, including the demo cookie;
    - the Caddyfile was checked in a throwaway caddy:2-alpine container.

## ADR-124: Docker is a first-class target: every feature ships for Kubernetes and Docker

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: WatchLog monitors Kubernetes clusters and Docker fleets (SPEC §4.4). Planning notes from before the launch suggested freezing Docker support and deciding its future from funnel data. Features then risk shipping for Kubernetes first and for Docker "later", which leaves Docker users with a weaker product and a growing list of gaps.
- Decision:
  - **Standing rule:** every WatchLog feature ships for both Kubernetes and Docker in the same release, unless an ADR explains why one side cannot have it (for example, a Kubernetes object that has no Docker equivalent).
  - **The same vocabulary per side:** Kubernetes uses namespaces, workloads and pods; Docker uses hosts, Compose projects and containers. APIs, tools and messages say which kind of cluster they describe.
  - **Tests and docs for both:** contract and end-to-end tests run against a kind cluster and a Docker host (the Docker agent); docs give examples for both.
  - This supersedes any earlier planning text that called Docker support frozen or tied its future to activation numbers.
- Consequences:
  - SPEC §4 states the rule; the workspace's working rules repeat it.
  - Feature estimates include the Docker side from the start.
  - The live demo is Kubernetes only for now; a Docker demo host is a follow-up, not a reason to ship features for Kubernetes only.

## ADR-125: Personal API tokens, read-only in v0.2

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: v0.2 lets people connect their own AI assistant (ADR-127) and scripts to WatchLog. Both need a credential that is not a browser session. SPEC §8 already names `Authorization: Bearer wl_pat_…`.
- Decision:
  - **Format and storage:** `wl_pat_` followed by 256 random bits (base64url), shown once. Stored as a SHA-256 hash with a display prefix, as cluster tokens are (ADR-040); a 256-bit random value needs no slow hash.
  - **Scope:** `read` only in v0.2. It allows the public GET routes (ADR-126), `POST /api/v1/query/range` (a read sent as POST) and `/mcp`. Everything else answers 403 `urn:watchlog:problem:token-scope`. A token can never manage tokens, users, setup or alerting settings. A write scope may follow in a later version with its own ADR.
  - **Expiry:** chosen at creation, default 90 days; "never" is allowed and marked in the list. Expired and revoked tokens answer 401.
  - **Revocation** is immediate: tokens are checked on every request, with no cache.
  - **Last used:** time and IP, written at most once a minute per token.
  - **Limits:** at most 10 active tokens per user (409 `token-limit`). Rate limits per token: 300 requests a minute for the REST API, 60 tool calls a minute for MCP; 429 with `Retry-After` above that.
  - **Token history:** created, revoked, expired and first use from a new IP are recorded per token and shown on its row. This is not the general audit log, which stays Enterprise (SPEC §4.10).
  - **Requests:** a request with both a token and a session cookie is refused (400), so it is never ambiguous which credential applies. Token requests skip the Origin/CSRF check, which protects cookie sessions only.
  - **Demo mode:** creating a token is refused like every write (ADR-122). The demo's public MCP token is the only exception (ADR-130).
  - **Upgrades:** a new table; nothing to do on existing installs (ADR-107).
- Consequences: Settings gets an "API tokens" tab. The UI waits for a mock-up.
- Amended 2026-11-08, after the mock-up review:
  - **Expiry reminder:** an email 7 days before a token expires, through the SMTP settings already used for email alerts. It is skipped silently when SMTP isn't configured.
  - **Listing:** expired and revoked tokens stay listed for 30 days with their history, their last-used IP shortened (/24, /48), then are deleted.
  - **The list** shows the prefix (`wl_pat_` and 4 characters) followed by "…", never more of the value.
  - **The one-time reveal** offers setup for Claude Code, Claude Desktop (`mcp-remote`), Cursor and the REST API, with the address taken from the instance's public URL. "Done" stays disabled until the user confirms they have copied and stored the token.
  - **In demo mode** the page shows the demo's public MCP token (ADR-130) with a ready Claude Code command, and "Install WatchLog" instead of token creation.
- Amended 2026-11-08, as built (v0.2 slice 1):
  - **What `read` allows:** every `GET`/`HEAD` under `/api/v1` except settings, alert channels, token management, auth, setup and demo; plus `POST /query/range` and `/mcp`. A route-walk test pins the exact set for a Kubernetes cluster and a Docker fleet, so any new GET route needs a decision. Slice 3 may narrow this to the routes tagged `public` (ADR-126).
  - **Errors:** a token sent with a session cookie answers 400 `urn:watchlog:problem:token-with-session`. 401 and 403 carry `WWW-Authenticate: Bearer` with `invalid_token` or `insufficient_scope`.
  - **Country:** the last-used country is taken only from a trusted proxy's header named in `WATCHLOG_CLIENT_COUNTRY_HEADER` (Helm `backend.clientCountryHeader`, empty by default); there is no GeoIP.
  - **History cap:** at most 50 "new IP" events per token.
  - **Hidden from tokens:** cluster-token prefixes are not returned to token requests, as in demo mode.
- Amended 2026-11-08, v0.2 slice 2:
  - **No error text for tokens:** `GET /alerts` and `GET /alerts/:id` leave out notification and delivery error text for token requests, as in demo mode. That text can carry an SMTP host or user, or part of a webhook URL, and a token's reader may pass it on. Sessions still see it.
  - **`read` becomes an allowlist (built in slice 3):** a token may read only the routes tagged `public` (ADR-126), plus `/mcp`, instead of every GET minus a deny list. A new route is closed to tokens until it is tagged. The route-walk test stays as the guard, for a Kubernetes cluster and a Docker fleet.

## ADR-126: A public, stable REST API for tokens

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: once tokens exist, people write scripts against the API. Nothing so far said which routes they can rely on.
- Decision:
  - **Public routes**, tagged `public` and documented: the cluster list and detail, overview, nodes, workloads, pods, namespaces, events and their summary, change markers, Docker hosts and containers, the service map and its edges, alerts and alert detail and chart, alert rules (read), silences (read), `POST /query/range` (catalog keys only), `GET /me`, `GET /health`.
  - **Internal:** setup, auth, demo, settings, alert channels, every write, and `/ingest/*`. They may change without notice.
  - **Versioning:** stays `/api/v1`. Additive changes are allowed at any time. A breaking change to a public route needs `/api/v2` or a deprecation that lasts two minor versions.
  - **The spec:** `GET /api/v1/openapi.json` serves the public routes with a `bearerAuth` security scheme. A committed snapshot of the public spec fails CI on a breaking change.
  - **Docs:** `docs/site/api.md` covers tokens, curl examples, errors and limits, and links the spec. No interactive reference on the site in v0.2.
- Consequences: changing a public route's response is a deliberate act: update the snapshot, and the ADR if it breaks.
- Amended 2026-11-08, as built (v0.2 slice 3):
  - **The tag:** a route is public when its schema's tags include `public` (`PUBLIC_TAG`, `backend/src/openapi/public.ts`). The same tag opens it to API tokens (ADR-125's allowlist), so the spec and what a token can read can't drift apart. The route-walk test pins the set for a Kubernetes cluster and a Docker fleet.
  - **The set:** the 24 operations listed above. `GET /alerting/status`, readable by tokens under the old deny list, is internal: it reports the server's own setup (SMTP, the public address).
  - **`GET /me`** also returns the token a request came with (name, prefix, scope, expiry), null with a session, so a script can check its token.
  - **The spec** is served without a token: it describes routes, not data. Its `info.version` is the release; the snapshot stores `v1`.
  - **The snapshot** is `packages/api-types/openapi.public.json`, written by `pnpm -C backend openapi:snapshot`. A test fails when the served spec differs from it, naming each breaking change. The command writes additions, and refuses a breaking change unless `--breaking` is given.
  - **Breaking:** an operation or a response field removed, a response field made optional or given a new type (null included), a new required parameter or body field, a parameter removed, a narrower type or range, or fewer accepted values. New routes, optional parameters, response fields and enum values are additions; the docs tell clients to tolerate them.

## ADR-127: An MCP server built into the backend

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: people want to ask their own AI assistant (Claude, Cursor, any MCP client) about their cluster. WatchLog should supply facts and run no LLM itself: no model cost, and no cluster data leaves unless the user connects a client. MCP clients connect over stdio or Streamable HTTP.
- Decision:
  - **Built in:** `POST /mcp` on the backend, Streamable HTTP, behind a read-scoped API token (ADR-125) in the `Authorization` header, with the same auth, rate limits and org scoping as the API. No separate stdio binary.
  - **Clients:**
    - Claude Code connects directly (`claude mcp add --transport http … --header "Authorization: Bearer …"`);
    - Cursor uses its `url` and `headers` configuration;
    - Claude Desktop uses `mcp-remote` with the header.
  - **Protocol through the official MCP TypeScript SDK**, never a hand-written protocol layer. It negotiates both the current protocol generation and the 2025 versions that deployed clients still use. Real clients prove this in tests: Claude Code, Claude Desktop through `mcp-remote`, Cursor where it can be scripted, and the SDK's own client.
  - **Stateless:** no server-held sessions and no server-initiated notifications in v0.2, so any backend replica can answer any request.
  - **OAuth later:** OAuth for MCP (v0.3 or later) is what the native "custom connector" experience in Claude's apps will most likely need. Until then, bearer tokens and `mcp-remote` cover Claude Desktop.
  - **Call log:** every tool call records the time, the token prefix, the tool, a short argument summary, the status, the duration and the result size, never the output. Kept 30 days, the last 50 shown per token in Settings.
  - **Helm and Compose:** `mcp.enabled`, default on (it needs a token anyway), with a documented opt-out.
- Consequences:
  - The backend must be reachable from where the AI client runs (`publicUrl`, a VPN or a tunnel); the docs say so.
  - AGPL: the MCP server is part of the backend, so its network use is covered like the rest.
- Amended 2026-11-08, as built (v0.2 slice 4):
  - **SDK:** `@modelcontextprotocol/server` 2.4.0, the SDK's v2 line, pinned exactly. v1 (`@modelcontextprotocol/sdk` 1.32.2, the newest v1) speaks only up to 2025-11-25. v2 implements 2026-07-28 and serves 2025-era clients through `createMcpHandler`'s stateless fallback (`legacy: 'stateless'`). The tests drive the SDK's v2 client (`@modelcontextprotocol/client` 2.4.0, dev only) pinned to 2026-07-28 and in its plain 2025 handshake (negotiated 2025-11-25). No Hono or Express: the handler's web-standard `fetch` is called from the Fastify route.
  - **Reads through the API:** a tool calls the public REST routes in-process (`app.inject`) with the caller's own token, so it never sees more than the API shows that token: org, allowlist, demo limits and redaction all apply. A secret made at start marks these calls, so they neither count against the REST limit nor count as REST use; the MCP call is counted and logged instead.
  - **Limits:** 60 tool calls a minute per token, answered in-band (`isError`, `retryAfterSeconds`) and logged as `rate_limited`. Every `/mcp` request, tool listing included, also counts toward the token's 300 requests a minute.
  - **Errors:** without a token, 401 with `WWW-Authenticate: Bearer realm="WatchLog", scope="read"` and how to get one. Tool failures are in-band results with WatchLog's sentence, a hint and the asked values as data.
  - **Call log:** `mcp_calls` (tool, an argument summary WatchLog writes, at most 200 characters, status `ok`, `truncated`, `rate_limited` or `error`, duration, bytes), deleted after 30 days by the alert-worker's hourly token upkeep. The list's `mcpCalls30d` and the detail's last 50 calls come from it.
  - **Off switch:** `mcp.enabled: false` (Helm) or `WATCHLOG_MCP_ENABLED=false`: `/mcp` is not registered.
- Amended 2026-11-08, v0.2 slice 6 (real clients): `deploy/test/k8s/mcp-e2e.sh` (checks in `backend/scripts/mcp-e2e.ts`) runs against the kind demo and a Docker host. It makes a token, then:
  - the SDK client, negotiating 2026-07-28 and 2025-11-25;
  - Claude Desktop's path, `npx mcp-remote@0.15.2` over stdio with the token in an environment variable, pinned to a release at least two weeks old;
  - Claude Code headless (`claude -p --mcp-config … --strict-mcp-config`), which changes no Claude Code settings;
  - Cursor only when its `cursor-agent` CLI is installed;
  - revoking the token, then a call that must fail.
    It is manual like the other acceptance scripts: Claude Code runs on the user's account, and the demo needs a VM.

## ADR-128: MCP tools: read-only, compact, bounded, for Kubernetes and Docker

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: an AI assistant needs facts it can reason over, not dumps of objects. Tools must be safe to call repeatedly and must never leak what the API never shows.
- Decision:
  - **Tools (all read-only, `readOnlyHint`):** `list_clusters`, `get_problems`, `list_alerts`, `explain_alert`, `get_workload`, `get_pod`, `get_node`, `get_service_map`, `get_events`, `get_recent_changes`, `query_metric`. Prompts: `investigate_problem`, `why_is_it_crashing`. No resources in v0.2.
  - **Both kinds of cluster (ADR-124):** every tool takes a cluster and returns its kind (`kubernetes` or `docker`) with that kind's vocabulary:
    - Kubernetes: namespaces, workloads and pods, with nodes;
    - Docker: hosts, Compose projects and containers.

    `get_workload` and `get_pod` answer for a Compose service and a container on Docker; `get_node` answers for a Docker host. `get_problems`, `list_alerts`, `get_service_map`, `get_events` and `query_metric` use WatchLog's existing Docker problems, reasons and catalog keys.

  - **Output:** compact JSON with WatchLog's existing reason sentences (restart, OOM, health check, failed connection). No raw objects.
  - **Hard caps on every tool:**
    - a maximum number of items (for example 50 problems, 30 edges, 30 event groups, 10 series of at most 60 points);
    - at most 16 KB of output.

    Beyond a cap the result carries `truncated: true`, the remaining count, and the hint "truncated, narrow your query", plus which argument narrows it.

  - **`query_metric`:** catalog keys only, never raw MetricsQL. At most 24 hours, 10 series and 60 points, with statistics by default.
  - **Never returned:** Secrets, environment values, payloads, alert channel targets, SMTP and Telegram settings, tokens. Outputs pass the API's redaction, and a test scans every tool's output for secret fixtures.
  - **`explain_alert`:** in v0.2, the alert, its rule, the object's state, its last terminations, related events, and the changes in the window before. v0.3's probable cause adds a likely cause with evidence to the same tool.
- Consequences:
  - Each tool has a contract test against a seeded backend for a kind cluster and a Docker fleet.
  - An end-to-end test on kind and on a Docker host drives a real MCP client.
- Amended 2026-11-08, slice 4 as built (`list_clusters`, `get_problems`, `list_alerts`, `get_pod`):
  - **`cluster`** takes a name or an id and may be left out when the token sees one cluster; otherwise the error lists the clusters.
  - **Caps:** 50 clusters, 50 problems, 30 alerts, 10 containers and 10 events per pod or container, then 16 KB. A cut answer carries `truncated`, `shown`, `total` and a hint naming the argument that narrows it ("Pass `namespace` to see one namespace.").
  - **No rendered titles:** the dashboard's problem and alert titles put names inside sentences, so tools leave them out. A problem has `type`, WatchLog's `reason` for that type, the `object` as data, and the dashboard's line as `detail`. An alert has its rule and its labels as `object`.
  - **Docker vocabulary:** problems and containers name their `host` (not a namespace), `get_pod` answers for a container by name (and `host` when the name runs on several), and Kubernetes arguments on a Docker fleet get an error that says so.
  - **Health checks:** a container's health shows its status, failing streak and start, never the probe output (it is the workload's own command output).
  - **Descriptions** are written for the assistant: when to use the tool, what it returns, its limits, one example question, and the data note of ADR-129. Every tool is `readOnlyHint`, not destructive, idempotent and not open-world.
- Amended 2026-11-08, slice 5 as built (`explain_alert`, `get_workload`, `get_node`, `get_service_map`, `get_events`, `get_recent_changes`, `query_metric`; prompts `investigate_problem` and `why_is_it_crashing`):
  - **`explain_alert`** states facts and guesses no cause. It returns the alert, how often it fired before, the current state of what it is about (a pod and its containers, a workload, a node, a Docker container or Compose service), up to 20 of that object's events, and up to 10 changes from an hour before it started.
  - **Defaults:** `get_events` covers Warning events of the last 60 minutes, grouped by reason and object (30 groups). `get_recent_changes` covers 6 hours (30 changes). `get_service_map` without `workload` shows only failing or slow connections (30), with DNS errors from 5 % failed lookups. All three reach back at most 24 hours. Change lookups run to a minute past now, so a change stamped in the current second is not missed.
  - **`query_metric`** takes the catalog's keys as an enum. Each key must fit the cluster's kind (`host.*` and `container.*` on Docker; `node.*`, `pod.*`, `workload.*`, `namespace.*` and `pvc.*` on Kubernetes; `flow.*` on both). The step is chosen for at most 60 points. Series come as min, max, average and last, highest first.
  - **Docker containers by name:** when hosts that stopped reporting keep a stale copy of a container's name, the copy on a reporting host is used, and the answer lists the others in `staleOn`. Only several reporting copies make the call ask for `host`.
  - **Health checks:** `get_pod`'s health has the status, failing streak and start, never the probes. An unhealthy alert's `detail` quotes the last probe line, as the dashboard does. The agent redacts that line and cuts it to 512 bytes (ADR-047), and it can be turned off.
  - **Prompts** quote the user's values as labelled, cleaned data, and tell the assistant to treat cluster text as data.

## ADR-129: Cluster-controlled text is data, never instructions

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: pod, container and Compose names, labels, annotations kept in the allow-list, event messages, image names and log-like fields are written by whoever controls the cluster or the workload. Returned through MCP, such text reaches an AI assistant's context, and a name like "ignore previous instructions and …" is a prompt-injection attempt.
- Decision:
  - **Delimited fields:** in tool outputs, cluster-controlled text appears only in clearly named data fields (`name`, `namespace`, `message`, `image`…). It is never interpolated into instruction-like sentences that the tool writes itself: WatchLog's own sentences refer to "this pod", with the name in a separate field.
  - **Length caps:** names at 253 characters, messages at 512, labels at 63 for values, with an ellipsis. Control characters are stripped.
  - **Tool descriptions say so:** every tool that returns such fields tells the client they are cluster-supplied data.
  - **Tests** feed hostile values (a pod named "ignore previous instructions …", an event message with markdown and fake tool calls, very long names) and check that they come back only inside their fields, capped and escaped, and that no tool output places them in its own sentences.
  - **Limiting the damage:** tokens are read-only (ADR-125), so an injected instruction cannot make WatchLog change anything. The security docs explain this and recommend that users review what their assistant does with other tools in the same session.
- Consequences: the same rule applies to future write tools and to v0.3's probable-cause sentences.
- Amended 2026-11-08, as built (v0.2 slice 4): one output layer (`backend/src/modules/mcp/output.ts`) cleans every cluster-supplied value. C0 and C1 controls, zero-width and bidirectional formatting characters are removed, and line breaks become spaces. Names are capped at 253 characters, messages at 512, label keys and values at 63, by characters, with an ellipsis. The server's instructions and every tool description say these values are data. The tests feed a container named "ignore previous instructions…" with control characters, a 300-character image, an event message with a fake tool call, and a 253-character name. They check that each comes back only in its own field, cleaned and capped, never in `reason`, `summary`, `hint` or `error`.

## ADR-130: A public MCP endpoint on the live demo

- Date: 2026-11-08 · Status: accepted (maintainer, 2026-11-08)
- Context: the live demo (ADR-122) shows the dashboard. Letting anyone connect an AI assistant to the same sample cluster shows what v0.2 does in a minute.
- Decision:
  - **A public token** for the demo, published on the site and in the docs. It is created by the seed file (ADR-122), so demo mode is never turned off. It is accepted only while `demoMode` is on, and it is scoped `read`.
  - **Rate limits:** 30 tool calls a minute per visitor (the real IP behind the trusted proxies, ADR-123) and 600 a minute in total, on top of the demo's query caps (24 hours, 1,000 points, 10-second queries).
  - **Demo analytics** (in its private deployment) count `/mcp` requests as their own source and list which tools were called. Tool arguments and outputs are not kept.
  - **Rotating the token** means changing the seed value and the docs.
- Consequences:
  - The site's "Ask your cluster" section ships together with the token, behind a site flag.
  - Abuse is bounded by the limits above, nginx's per-visitor limit and the demo cluster's CPU and memory caps.
- Amended 2026-11-08, as built (v0.2 slice 7, release 0.2.0):
  - **The token** is `seed.demoMcp.token` in the seed file, any value of an API token's shape. At start, in demo mode, it becomes a read token of the demo viewer account; a new value replaces the old. Without demo mode the account has no token, and the token plugin refuses it anyway. `GET /setup` returns it as `demoMcpToken` in demo mode, for Settings → API tokens.
  - **Limits:** 30 tool calls a minute per visitor and 600 in all (`seed.demoMcp.visitorCallsPerMinute` and `totalCallsPerMinute`), answered in-band and saying which limit was hit. Its REST requests are limited per visitor, not per token.
  - **Nothing about visitors is kept** in WatchLog: no last use, no address, no history event, no call log.
  - **Demo mode's guard** lets `POST /mcp` through: its tools only read.
  - **Analytics:** every `/mcp` answer carries `x-watchlog-mcp` (the JSON-RPC method and tool, never arguments). The demo's nginx logs it, and the waitlist's Demo page shows MCP visits, their client and the tools called.
  - **The web image's Caddy** forwards `/mcp` with streaming unbuffered, and answers 404 for OAuth metadata paths, which MCP clients probe when a token is refused. The demo's nginx does the same.

## ADR-131: A separate integrations collector, one per Kubernetes cluster or Docker host

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Context: v0.3 monitors services that run next to the workloads: Redis, PostgreSQL, Nginx, MongoDB, RabbitMQ and Elasticsearch (SPEC §4.12). Reading them needs network clients and, for some, credentials. The node agent must stay within its budgets (SPEC §6.1) and never read secrets (SPEC §6.6).
- Decision:
  - **A third binary and image**, `integrations`, in the agent's Go module (ADR-048), published as `ghcr.io/watchlog-light/integrations`. It reuses the agent's remote_write encoder, disk buffer and sender (ADR-021, ADR-022). Budgets: image ≤ 40 MB compressed, ≤ 128 MB RSS and ≤ 5 % of a core with all six integrations on one instance each. These are measured in the release test and are hard limits like the agent's.
  - **Kubernetes:** one Deployment per cluster (1 replica), `integrations.enabled: true` by default in both charts (nil-safe, ADR-107). It needs no ClusterRole. It reaches services over the pod network by Service name or pod IP, and the backend names the targets. A NetworkPolicy that blocks it is reported as "can't connect", with the policy fix in the message.
  - **Docker:** one container per host that runs a monitored service, started with `--network host` so it reaches the containers' bridge addresses on that host. The connect flow shows its `docker run` command the first time a service on a host without a collector is monitored. Hosts without monitored services run nothing extra.
  - **Push only, like the agents:** the collector authenticates with the cluster's token. It pulls its configuration from `GET /ingest/v1/integrations/config` every 30 s (ETag), pushes metrics through remote_write and status and snapshots through `POST /ingest/v1/integrations`. The backend still never connects into a cluster (SPEC §5.2).
  - **Read-only by construction:** each integration runs a fixed list of statements or commands, written in the code and tested; there is no way to send it a query. Connections are opened with read-only session settings where the service has them (PostgreSQL `default_transaction_read_only`, short `statement_timeout` and `lock_timeout`).
  - **Load on the monitored service** is bounded: one connection per instance, a 30 s scrape for heavy views (tables, statements, queues) and 15 s for the rest, and a 5 s timeout per call.
- Alternatives: integrations inside the node agent (rejected: database clients break the agent's budget, and credentials would reach every node); inside the backend (rejected: the backend never connects into clusters, and in Cloud it cannot); a Prometheus exporter per service (rejected: one exporter image per service to install and wire up, and no discovery, connect flow or reasons).
- Consequences: a third image in the release and verify workflows; the upgrade test covers the new chart values. Docker users may run one more container per host that has services.
- Amended 2026-11-09 (owner's answers):
  - **Accepted.**
  - **Docker:** the collector runs with `--network host`, as uid 0 with every capability dropped and a read-only root filesystem, so it can read root-owned `0600` files under `/etc/watchlog/secrets/` (ADR-134). The install docs and `/security` say so.
  - **Long-poll:** the config endpoint long-polls (`?wait=25`, answering early on a change). A probe started in the connect drawer reaches the collector within a second instead of 30 s.
- Amended 2026-11-09 (as built, slice 1): collectors are kept in their own table, `integration_collectors` (cluster, host, mode, version, footprint, last config), not in `agent_instances`, which counts nodes and hosts. The configuration is a long-poll (`GET /ingest/v1/integrations/config?wait=25`, ETag), woken when a service, probe or access changes; status at `POST /ingest/v1/integrations/status` is also the heartbeat. On Docker the collector runs as uid 0 with every capability dropped, so it can read root-owned `0600` files in `/etc/watchlog/secrets`.
- Amended 2026-11-09 (owner, after testing v0.3 on the dev stack):
  - **The Docker collector reports where the host's agent does.** The command WatchLog shows takes `WATCHLOG_ENDPOINT`, like `WATCHLOG_TOKEN`, from the `watchlog-agent` container; when the agent has none, the ingest or Public URL; with neither, the command stops and says to set the Public URL. The browser's address (often `localhost`) is never used. A test runs the command in bash against a stand-in `docker`; the demo starts its collector the same way.
  - **A status report is not refused for one long value.** The schema keeps only generous outer bounds; values over the stored limits (an error 512 characters, an `extra` value 256, 100 rows, 16 members) are cut short and a warning names what was cut.
  - **Dev and demo start the collectors themselves:** `demo-up.sh` runs the collector on the demo's Docker host, and the agent chart already runs one in the cluster; `./dev.sh product` runs `demo-up.sh --existing` once the backend answers.

## ADR-132: Services are discovered from what the agents already see

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Signals:**
    - container images from the cluster-agent's pods and from the Docker agent;
    - container ports: the pod spec summary gains `ports` (a trimmed list, ADR-053), and Docker already has them;
    - Service ports;
    - eBPF flows into a workload on a well-known port.
  - **Matching:** a small table per integration of image names and ports. Some examples:
    - `redis`, `bitnami/redis`, `valkey/valkey` on 6379;
    - `postgres`, `bitnami/postgresql`, `cloudnative-pg` on 5432;
    - `nginx` on 80/443, and `ingress-nginx/controller` with its metrics on 10254;
    - `mongo` on 27017;
    - `rabbitmq` on 5672 and 15692;
    - `elasticsearch` on 9200.

    The image wins over the port. A port alone gives "maybe PostgreSQL", shown with a lower confidence and never monitored without a click.

  - **Identity:** a service instance is a workload (StatefulSet, Deployment) on Kubernetes, or a Compose service or container on Docker. Its targets are its pods or containers, so replicas and replica sets are one service with several members.
  - **The list:** discoveries are kept in `discovered_services` and shown on the Applications page as "Found N services that aren't monitored yet". **Ignore** hides one until its image changes. **Add manually** takes a host and port for a service the agents can't see, such as a managed database.
  - **Nothing is contacted** until someone presses Monitor; discovery reads only what the agents already send.
- Consequences: one small cluster-agent change (container ports in the pod summary) and a backend matcher with fixtures for both kinds of cluster.
- Amended 2026-11-09 (owner's mock-up): **Accepted.** The discovered rows offer Monitor only. Ignore is not in v0.3's UI; the backend keeps the field for later.
- Amended 2026-11-09 (as built, slice 2): discovery is computed on read from the objects (running pods and containers; image first, then port); there is no `discovered_services` table, so there is no Ignore state to keep (the mock-up has no Ignore). eBPF destination ports aren't used for discovery yet.
- Amended 2026-11-09 (owner, after testing v0.3): **Ignore** after all, as a table of what people chose (`discovery_ignores`): one candidate by its key, or every candidate in a namespace or Compose project, including ones found later. Ignored ones are listed under the found services, to restore. Owners and Admins only. The Applications page lists the monitored services first; the found ones come below, three at first, with "Show all N" grouped by namespace or project. A Valkey image is found as Redis with `product: "valkey"`, and a monitored Valkey says so through the collector (`server_name:valkey` in INFO, with Valkey's own version): "Valkey 8.0 (Redis-compatible)".

## ADR-133: Integration credentials are stored encrypted (replaces "named Secrets only")

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Context: roadmap v1.2 allowed only Kubernetes Secrets named in Helm values. The owner decided that WatchLog may store generated or entered credentials, so connecting a database takes one command and no Helm upgrade. The user's own Secret or file stays as an option (ADR-134).
- Decision:
  - **At rest:**
    - AES-256-GCM with the installation's `WATCHLOG_SECRET_KEY` (ADR-079), in `integration_credentials`: one row per service instance, the ciphertext, the key id prefix (`v1:`), the method (`generated`/`entered`/`reference`), the user name and when it was set and verified.
    - Each ciphertext is bound to its row with associated data (the instance id), so a ciphertext copied to another row does not decrypt.
    - The secret-key canary (ADR-079) covers these rows too: the backend refuses to start with a key that can't decrypt them.
  - **Key rotation:**
    - `backend rotate-secret-key` takes the old and the new key. It re-encrypts channel, SMTP and integration secrets in one transaction under a new key id, then updates the canary.
    - The backend accepts both keys during the switch through `WATCHLOG_SECRET_KEY_PREVIOUS`, so a rolling restart never fails.
    - Documented with a test.
  - **Who can do what (ADR-140):**
    - Owners and Admins can set, replace or remove a credential. Viewers see only "set by <name> on <date>, last verified <time>".
    - Nobody can read a password back, through the UI, the REST API or MCP. The API is write-only, like channel secrets.
  - **What the collector receives:**
    - The configuration endpoint returns the decrypted credential only to the collector of that service's cluster (its cluster token), and only for the instances assigned to it, over TLS.
    - The collector keeps it in memory, never writes it to disk or logs, and drops it when the integration is removed.
    - Responses carrying credentials are `Cache-Control: no-store` and never written to the ingest debug log.
  - **Audit:** `integration_events` records who set, replaced, verified, paused or removed a credential, with time and IP. It never records the value, and it is shown on the service's settings drawer. This is a log for this feature, not the Enterprise audit log.
  - **Demo mode:** the connect flow and credential routes are refused, like every write (ADR-122). The demo's own integrations come from the seed file with `reference` credentials.
- Alternatives: Secrets only (rejected by the owner: a Helm upgrade or a hand-made Secret for every database); storing credentials in a Kubernetes Secret that WatchLog creates (rejected: needs write access to Secrets, against SPEC §6.6, and has no Docker equivalent).
- Consequences: backups of the database without the key cannot reveal credentials; losing the key means re-entering them (docs say so). Security docs and `/security` gain a section.
- Amended 2026-11-09: **Accepted** (owner).
- Amended 2026-11-09 (as built, slice 4): ciphertexts are bound to their row with AES-GCM associated data (the service's id; a probe's id until it becomes a service, then re-encrypted). `rotate-secret-key` re-encrypts alert channel, SMTP, integration and probe secrets and the key check in one transaction. During a rolling restart, decryption falls back to `WATCHLOG_SECRET_KEY_PREVIOUS` (Compose variable, Helm `secretKeyPrevious`). A credential that can't be opened is left out of the collector's configuration, so the service reports it can't log in and the others keep working. The log (`integration_events`) keeps `removed` after the service is gone; Viewers see it without IP addresses.

## ADR-134: Three ways to connect a service that needs a user

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Nothing needed:** Redis without a password, Nginx (eBPF; ingress-nginx metrics), RabbitMQ with the Prometheus plugin, and Elasticsearch or MongoDB with security off start when Monitor is pressed.
  - **a. Recommended, a generated user:**
    - WatchLog generates a 32-character password (`wl_mon_…`) and writes the exact one-time command with the names the agents saw. Kubernetes: `kubectl exec -n <ns> <pod or statefulset/x> -- psql …`. Docker: `docker exec <container> …`.
    - Each command creates the least-privileged role: `pg_monitor`; Redis ACL `+info +slowlog +latency +config|get +client|list +ping`; MongoDB `clusterMonitor`; an Elasticsearch API key with `monitor`.
    - The collector tries to log in every 5 s for 15 minutes and the drawer turns green as soon as it can. After that, a "Check again" button.
  - **b. An existing user:**
    - Name and password, stored encrypted (ADR-133).
    - The collector checks the user's privileges on the first connect. If it has more than needed (superuser, write grants, `+@all`), the page says so and suggests a dedicated user. It still connects: it is the user's choice.
  - **c. Your own Secret or file:**
    - Kubernetes: the user names a Secret and key. WatchLog writes the `kubectl create role … --resource-name=<secret>` and `rolebinding` commands that let only the collector's ServiceAccount read that one Secret. The collector reads it through the API with its ServiceAccount token, without client-go.
    - Docker: a file under `/etc/watchlog/secrets/` on the host, mounted read-only into the collector.
    - WatchLog stores only the reference.
  - **Missing permissions later:** each integration knows which tab needs which privilege or setting. The service page names the affected tab and the fix, for example pg_stat_statements not installed → the Queries tab shows `CREATE EXTENSION` and the `shared_preload_libraries` line. The other tabs keep working.
- Consequences: the generated commands are tested against real services on kind and Docker (they are run by the tests, not only shown).
- Amended 2026-11-09 (owner's mock-up):
  - **Accepted.**
  - **Probe before Start monitoring:** for services that need nothing, the drawer probes when it opens and shows what it found ("Redis 7.2, 312 MB used, no replicas").
  - **Secret option:** the user's Secret lives in the `watchlog` namespace. WatchLog writes the `kubectl create role … --resource-name=<secret>` and `rolebinding` lines for that one Secret.
  - **Redis's ACL** adds `+memory|stats +memory|usage +scan` for the Memory tab.
  - **"Check now":** besides the 5 s polling, "Check now" probes at once.
- Amended 2026-11-09 (as built, slice 4): the test before Start monitoring is a probe (`integration_probes`), tried by the service's own collector every 5 s for 15 minutes, at once when new or on "Check now", which also gives it 15 more minutes. "Nothing to set up" types probe as the drawer opens. The Secret's namespace and the ServiceAccount in the role commands are the ones the collector reports (downward API), defaulting to `watchlog`. A Docker password file must be a plain name directly under `/etc/watchlog/secrets`. A Docker host without a collector gets a `docker run` command that takes the token from the host's `watchlog-agent` container, so no token is shown. Until each integration lands (slices 7+), probes and scrapes are a TCP check: they prove reachability, not the login.
- Amended 2026-11-09 (as built, slices 7 and 8): Redis and PostgreSQL probes log in and check privileges: a Redis probe runs each command the tabs need and reports the ones its ACL refuses; a PostgreSQL probe checks `pg_monitor` membership (a superuser passes, flagged as more than needed) and reports whether `pg_stat_statements` is installed. The drawer stays amber until the login succeeds; a refused password is `auth_failed`, a missing privilege `permission_missing` with the `GRANT` or `ACL SETUSER` to run. A scrape whose every member refuses the login reports `code: auth_failed`, and the service's health reason is `login_failed` ("the user or password is refused"), not `unreachable`. The generated commands are run for real by `deploy/test/redis-e2e.sh` and `postgres-e2e.sh`, through `kubectl exec` and `docker exec`, with the Secret and host-file paths on kind and Docker.

## ADR-135: The Applications page, one service-page template and shared panels

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Applications** is a main navigation entry with a problems count.
    - **The list:** one row per service instance, with type logo, name and where it runs, health and its one-line reason, three key metrics, a 6 h sparkline and the firing alerts. Problems come first, filters by type.
    - **Discovery:** "Found N services that aren't monitored yet" sits above the list.
    - **Phones:** the rows become cards.
  - **The service page** is one template filled per integration:
    - the header (logo, name, version, where, monitored since, "Open in service map", settings);
    - "What WatchLog sees" (the reasons, ADR-137) and stat tiles;
    - tabs by metric family, each a grid of panels;
    - "Alerts for this service";
    - the workloads or containers connected to it, from the service map;
    - the MCP hint.

    The tab is in the URL (`?tab=locks`).

  - **Shared panels, built once** in `web/src/components/panels/` on the ECharts wrapper (ADR-036):
    - a line with a limit line;
    - a stacked area;
    - horizontal bars;
    - a histogram;
    - a capacity gauge with a threshold mark;
    - an hour × day heatmap over 7 days;
    - a table;
    - stat tiles.

    Each panel takes a catalog query and a small options object, follows the page's time range, and has loading, empty, error and "needs a permission" states.

  - **Overview and MCP:** a service problem joins the overview's Needs attention list with its reason (ADR-110).
- Consequences: integrations add panel definitions, not components; a new integration is mostly a catalog, reasons and tests.
- Amended 2026-11-09 (owner's mock-up):
  - **Accepted.**
  - **The list:** columns Service, Where, Health with its one-line reason, three key metrics, the last 6 h, firing alerts; a Sort control (problems first, name, cluster).
  - **The service page:** its own time range (1 h, 6 h, 24 h, 7 d); the panel grid has two columns (one on phones) and a panel may span both. "Alerts for this service" and the connected workloads show on the Overview tab.
- Amended 2026-11-09 (as built, slice 3): the backend describes each type's tabs and panels and fills them (`GET /applications/:id/panels?tab=&range=`); the web draws panels by kind. Panel and tab titles are i18n keys. Until a type's integration lands it gets a generic Overview (members reachable, connect time, read time). A tab whose privilege the collector reports missing has its panels marked "needs a permission" with what to grant. The list's key numbers and 6-hour sparklines come from their own route (`GET /applications/metrics`), so a slow metrics store never holds the list back. `GET /applications`, `/:id`, `/discovered` and `/collectors` are public (ADR-126); the panels route is the dashboard's own.

## ADR-136: Integration metrics, caps and alert rules

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Series:**
    - `watchlog_<service>_<metric>`, with `cluster_id` (server-injected), `service` (the instance id), `member` (pod or container) and only the family labels the catalog lists (`db`, `table`, `queue`, `node`, `command`, `state`, `status`).
    - Statement and slow-log fingerprints are labelled by a stable id. Their normalised text is kept in PostgreSQL (`integration_texts`), not as a label.
  - **Caps per instance:**
    - 50 databases;
    - 100 tables, by size;
    - 200 queues, by depth;
    - 50 statements, by total time;
    - 50 indices;
    - 20 commands.

    The rest are summed into `other`. A cap that cuts something is shown on the panel ("top 100 of 340 tables").

  - **Catalog keys:** every metric on a service page is a query catalog key (ADR-028), so it can be charted, alerted on (ADR-072 metric rules), queried through MCP and served by the public API.
  - **Rule scope:** the rule editor (ADR-096) gains a "service" scope (one instance or every instance of a type) and lists that service's metrics in the metric slot. "+ Add rule" on a service page opens the editor with the scope set.
  - **Default rules per integration** (SPEC §4.12) are created disabled, and the connect flow's checkboxes enable them for that instance. Like ADR-084's defaults, they can be edited and reset.
  - **State-like conditions** ("replica set has no primary", "last save failed", "cluster red") are metric rules on 0/1 gauges, so there is still one rule model.
- Consequences: a cardinality test per integration with a large fixture (500 tables, 1,000 queues) checks the caps.
- Amended 2026-11-09: **Accepted.** The default rules per integration follow the mock-up (SPEC §4.12).
- Amended 2026-11-09 (as built, slice 5): the generic keys `service.reachable.ratio` and `service.connect.time` exist for every type, on both kinds of cluster; the query API and `query_metric` take a `service` scope. The rule editor's service scope is one instance (from its page); "every instance of a type" isn't built. The defaults so far are generic (unreachable, slow to connect); each integration adds its own. They notify the organization's channels. Reset to default isn't built for these per-service rules. Removing a service removes its rules.
- Amended 2026-11-09 (as built, slices 7 and 8): per-service default rules carry a `default_key` (migration `1793900000000`, backfilled) and "Reset to default" restores the default's condition, duration and severity (`POST /alert-rules/:id/reset`). Redis adds five defaults and PostgreSQL five (SPEC §4.12), with catalog keys `redis.*` and `postgres.*`. The caps are applied by the collector: PostgreSQL reads the 10 largest databases' tables and keeps the 100 largest over all of them (checked with 500 tables end to end), the top 50 statements by total time, 20 blocking pairs and 20 locked tables; Redis 20 commands, 20 slow-log entries and 20 key prefixes. Nothing is summed into `other` yet, and panels don't say "top 100 of N". Statement text isn't in `integration_texts`: the collector sends the top statements with their normalised text in the status's `extra` each heavy scrape, and the backend keeps the last one.

## ADR-137: Service reasons are structured facts, ready for probable cause

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Each integration has reason rules** that turn the latest values into `{ severity, code, facts, links }`:
    - `code` is stable, such as `pg.connections_near_max` or `rabbitmq.queue_no_consumers`;
    - `facts` are typed values (counts, percentages, durations, times);
    - `links` point to workloads, containers, edges or alerts.

    The sentence is rendered from the code and facts by the web and by MCP. Names stay in fields (ADR-129).

  - **Cross-signal links:**
    - A reason may link to a workload or container problem found through the service map. For example, a queue with no consumers links to the clients that consumed it in the last 24 h (eBPF edges to its port) and to their state: "billing-worker, its only consumer, stopped at 14:02 with exit code 137 (OOMKilled)".
    - These links are the inputs v0.4's probable cause ranks. v0.3 shows them but does not rank them.
  - **Reasons are evaluated by the backend** on read, cached for 15 s, and stored only when they back a firing alert (in its details).
  - **MCP:**
    - `list_applications`;
    - `get_application`: the reasons, key metrics, the tabs' latest values, connected workloads and firing alerts, within ADR-128's caps;
    - `query_metric` accepts the new catalog keys.
  - **The public API** gains `GET /applications` and `GET /applications/:id`, tagged `public`.
- Consequences: each reason has a unit test with its facts, and one end-to-end case per integration produces it on a real service.
- Amended 2026-11-09: **Accepted.**
- Amended 2026-11-09 (as built, slices 3 and 5): `GET /applications/:id` returns the reasons, most severe first: the health reason, each member that doesn't answer (linked to its workload or container), and each tab that lacks a privilege, then the integration's own. Metric-backed parts are cached 15 s. Alerts on a service carry `service_name` and the collector's last error as their reason, and link to the service page.
- Amended 2026-11-09 (as built, slices 7 and 8): reason codes are unprefixed (`memory_near_max`, `connections_near_max`); the type is the service's. PostgreSQL's reasons are SPEC §4.12's list; `connections_near_max` names the three clients holding most (workload, container, or application name) and `lock_waits` the blocking session's. Facts are strings or numbers only. MCP's `get_application` returns them with their facts; its sentence for an integration's own code is generic.

## ADR-138: Query text is kept normalised, or not at all

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **PostgreSQL:** pg_stat_statements text is already normalised by PostgreSQL (`$1`). WatchLog adds nothing.
  - **Redis:** SLOWLOG keeps the command name and the key shape. Parts that look like ids (digits, UUIDs, hashes) become `{id}`. Values and other arguments become `…`.
  - **MongoDB:** slow operations from `getLog` keep the operation, the namespace and the query shape. Every value becomes `?`.
  - **Elasticsearch:** no query text at all.
  - **Nginx:** request paths are not collected (ADR-139).
  - **A setting per instance:** "Collect query text" is on by default and shown in the connect flow. Off, only fingerprints, counts and timings are kept, and the texts already stored are deleted.
  - **Bounds:** texts are capped at 1 KB, kept for the metric retention, and never sent in alert messages.
  - **Docs:** `docs/site/security.md` and `/security` explain what is kept.
- Consequences: normalisation has tests with secrets in literals, emails, tokens and UUIDs.
- Amended 2026-11-09: **Accepted.** Redis key prefixes for the Memory tab are sampled names reduced to prefixes; values are never read (SPEC §4.12).
- Amended 2026-11-09 (found testing the dev demo): **PostgreSQL's text isn't always normalised.** `pg_stat_statements` replaces constants only in queries (SELECT, INSERT, UPDATE, DELETE, WITH, MERGE, …). Utility statements keep their literals: the `CREATE ROLE watchlog LOGIN PASSWORD '…'` WatchLog asks people to run showed in Slowest queries with its password. The collector now keeps a utility statement's command only (`ALTER ROLE …`, `DO …`), and redacts `PASSWORD '…'` in any text as a second guard; a real-server test runs `CREATE ROLE`/`ALTER ROLE … PASSWORD` and checks no password leaves the server. Redis keeps only the command for AUTH, HELLO, MIGRATE, `ACL …` and `CONFIG …`, whatever the server's own slow-log redaction does.

## ADR-139: HTTP stats on the service map, from eBPF, headers only

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **What:**
    - For plain-text HTTP/1.x on a traced connection, the agent records requests per edge: method class, status code and latency (request's first byte to response's first byte), in a histogram with ADR-106's buckets extended to 10 s.
    - No paths, no query strings, no other headers, no bodies.
    - TLS is never decrypted, and HTTP/2 and gRPC are not parsed in v0.3.
  - **How:**
    - `fentry` on `tcp_sendmsg` and `tcp_recvmsg` reads at most the first 16 bytes of each message on sockets already tracked as edges. That is enough to recognise `GET /…` and `HTTP/1.1 503`.
    - Counts are kept in the same per-CPU maps (ADR-099).
    - Both sides are observed, so server-side stats exist for workloads with outside clients, such as an ingress.
  - **Budget:** measured with the 1,000 connections/s load test; it must stay within SPEC §6.1. Off with `agent.networkFlows.http: false`.
  - **Use:**
    - The service map's edge panel shows requests/s, 4xx/5xx and p50/p95.
    - The edge health (ADR-106) also turns warning at ≥ 1 % 5xx and critical at ≥ 5 %.
    - The Nginx page reads these series for plain Nginx.
- Consequences: an eBPF change in both modes; kernel and verifier tests on the CI kernels; docs/security.md describes the 16-byte peek.
- Amended 2026-11-09: **Accepted.** Exact status codes are kept (capped to the common set) for the Errors tab.
- Amended 2026-11-10 (as built, v0.3 slice 9):
  - **Hooks:** `fentry/tcp_sendmsg` peeks at the message it sends. A receive is two hooks: `fentry/tcp_recvmsg` saves the iov_iter's first word per thread, and `fentry/tcp_cleanup_rbuf` peeks once data was copied (`copied > 0`; a blocking read calls it with 0 before it waits). The word is told apart (one user buffer, `ubuf`, or the kernel's iovec array, first non-empty segment) only after the copy: a freshly allocated receive buffer isn't paged in before it, and a non-sleeping program can't fault it in. Checking at entry lost about one fresh server connection in ten.
  - **Sides:** a client socket is one already tracked as an edge (ADR-099/108). A server socket is an accepted one: its local port isn't ephemeral and the pod filter (ADR-121) applies. Its stats are per (cgroup, local port): `watchlog_http_server_*` with the workload or container and `port`, next to the edge series `watchlog_http_*` with the flow labels (SPEC §6.3).
  - **Series:** `requests_total{code,class}` (21 slots: 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504, and 1xx–5xx for the rest; a code appears once seen), `requests_by_method_total{method=read|write}` (GET, HEAD and OPTIONS read; POST, PUT, PATCH and DELETE write), and `request_duration_seconds` with 15 buckets from 0.5 ms to 10 s.
  - **Edge cases:** a status line split across short reads is gathered up to 12 bytes. A server read shorter than 8 bytes is joined with the next one (Go's server reads 1 byte in the background on keep-alive connections). While a request waits for its response (up to 30 s), what looks like another request is its body; pipelining is practically unused, so this costs nothing real.
  - **Measured:** exact counts on both sides for Go's client and busybox wget (a new connection each time) in the kernel tests, on kernel 6.8 (x86_64 in CI, arm64 in Lima). The 1,000 connections/s count test passes with the HTTP hooks loaded. A tight loopback request loop costs about 0.5 µs more per request (+7.8 %).
  - **Kernels:** arm64 before 6.0 has no BPF trampoline, so these hooks (like the byte counters) don't attach there. The programs still load, so the verifier accepts them on 5.15. The agent then reports "no HTTP stats" with the reason, and flows and DNS work as before.
  - **Helm:** `agent.networkFlows.http` (default true, read nil-safe); Docker: `--ebpf-http` / `WATCHLOG_EBPF_HTTP`.

## ADR-140: Multi-user with Owner, Admin and Viewer, and email invites (Community)

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Roles** (one per user in the installation's org, ADR-035):

    | Can                                                                           | Owner | Admin | Viewer |
    | ----------------------------------------------------------------------------- | ----- | ----- | ------ |
    | See every page, alert, application and query text                             | ✓     | ✓     | ✓      |
    | Own API tokens (read) and MCP                                                 | ✓     | ✓     | ✓      |
    | Silence alerts, edit rules and channels                                       | ✓     | ✓     |        |
    | Add clusters, rotate cluster tokens                                           | ✓     | ✓     |        |
    | Monitor services; set, replace or remove integration credentials (never read) | ✓     | ✓     |        |
    | Server settings (address, email, Telegram)                                    | ✓     | ✓     |        |
    | Invite and remove Viewers and Admins, change their roles                      | ✓     | ✓     |        |
    | Change or remove an Owner, transfer ownership                                 | ✓     |       |        |

  - **Owners:** there is always at least one Owner, and the last one cannot leave or be demoted.
  - **Invites:**
    - An email with a link valid for 7 days, through the existing SMTP setup. Without SMTP, the inviter copies the link.
    - The link carries a 256-bit token stored as SHA-256.
    - Accepting sets a name and password (argon2id, ADR-025); an existing account just joins.
    - Pending invites can be revoked and resent.
  - **Enforcement:**
    - Every mutating route declares the roles it allows (`requireRole`).
    - A route-walking test, like the demo guard's, fails if a non-GET route has no role declared.
    - The web hides what a role cannot do and explains why when a link leads there.
  - **Tokens follow the user:**
    - A token acts with its user's current role, checked on every request.
    - Removing a user revokes their sessions and tokens at once. Demoting a user changes what their tokens can reach at the next request.
    - Tokens stay read-only (ADR-125), so a Viewer's token and an Owner's token read the same data.
  - **Demo mode:** the Users page shows the demo visitor as Viewer and refuses changes.
- Alternatives: Admin and Viewer only (rejected: someone must be able to remove an Admin); per-cluster roles (Enterprise, Phase 7).
- Consequences: SPEC §4.10 moves Owner/Admin/Viewer and invites to Community, v0.3.
- Amended 2026-11-09: **Accepted** (owner). Viewers are strictly read-only and cannot silence alerts.
- Amended 2026-11-09 (owner, with the Users and invites mock-ups, `design/v0.3-users`):
  - **Roles, as the mock-up shows them:**

    | Can                                                                               | Owner | Admin | Viewer |
    | --------------------------------------------------------------------------------- | ----- | ----- | ------ |
    | See every cluster, service, alert, the service map and query text                 | ✓     | ✓     | ✓      |
    | Personal read-only API tokens (MCP)                                               | ✓     | ✓     | ✓      |
    | Alert rules, channels and silences                                                | ✓     | ✓     |        |
    | Connect services and set their credentials (never read back)                      | ✓     | ✓     |        |
    | Add clusters, rotate their tokens, server settings                                | ✓     | ✓     |        |
    | Invite Admins and Viewers, change their roles, reset their passwords, remove them | ✓     | ✓     |        |
    | Hand ownership to an Admin; delete clusters and their data                        | ✓     |       |        |
    | Reset their own password from the command line when locked out                    | ✓     |       |        |

    There is exactly **one Owner**, whoever installed WatchLog, until they hand it over to an Admin (they become an Admin). Nobody can remove or demote the Owner; Admins can't reset the Owner's password.

  - **Invites never depend on SMTP:**
    - Creating one always shows a single-use link, valid for 7 days. The token is 256 bits, stored as SHA-256 for checking. So that "Copy link" works from the row while the invite is pending, the link is also kept encrypted with `WATCHLOG_SECRET_KEY` (ADR-133), bound to the invite, and deleted when it is used, revoked or expires.
    - The row shows "Pending invite" with Copy link and Revoke; an expired one shows "Invite expired" with New link (a new token, 7 more days) and Remove.
    - With SMTP the invite is also emailed; without, the dialog says nothing was sent and offers to set up SMTP.
    - Accepting (`/invite/<token>`) sets a name and a password of at least 12 characters and signs in; an expired or used link says so and names who to ask.
  - **Password reset links:**
    - Owners and Admins can create a single-use reset link for a user (Admins: for Admins and Viewers), valid for one hour. With SMTP it is also emailed.
    - The old password keeps working until a new one is set. Setting it signs the user out everywhere (every session ends).
    - With SMTP, "Forgot your password?" on the sign-in page emails a reset link to an existing account and answers the same either way.
  - **A locked-out Owner:** `watchlog admin reset-password [--email <address>] [--url <public URL>]`, run inside the backend container (`kubectl exec` / `docker exec`), prints a reset link. Without `--email` it resets the Owner. The link uses the Public URL setting, else `--url`. Anyone who can run a command in the backend container already controls the install, so printing the link there is safe. When SMTP is off, "Forgot your password?" shows this command.
  - **Removing a user** signs them out at once and revokes their API tokens. Alert rules, silences, channels and services they set up stay and keep working.
  - **Locked controls stay visible** to Viewers, with "Viewers can't change this. Ask an Admin." on hover or tap. The server refuses the same changes (`requireRole` on every mutating route, the route-walking test).
  - **Links** in invites and resets use the Public URL setting, falling back to the request's origin.
  - **Audit:** user changes (invite created, copied again, revoked, accepted; role changed; reset link created, by whom or by the command line; password set; user removed; ownership handed over) go to an `audit_events` log, shown to Owners and Admins on the Users page. Never a token or password.
  - **Demo mode:** the Users page is read-only, like every write (ADR-122).

## ADR-141: v0.3 build order and what moves to v0.5

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **Order:**
    1. foundation: the collector, discovery, the service page and panels, credentials and the connect flow, integration alerts;
    2. multi-user;
    3. Redis, then PostgreSQL;
    4. eBPF HTTP stats with Nginx;
    5. the remaining integrations;
    6. the site, docs and the demo;
    7. release 0.3.0.
  - **Estimate:** 27.5 sessions with all six integrations. MongoDB is 2 of them, RabbitMQ 1.5 and Elasticsearch 1.5.
  - **Time:** the big launch (early December, 3 December assumed) needs v0.4 (about 6 sessions) and launch preparation (about 2) after v0.3. At about 1.5 sessions a day, v0.3 must be released by 25 November, which leaves room for about 24 sessions (from 10 November).
  - **What moves:**
    - Elasticsearch moves to v0.5 now.
    - One more integration has to move too, or v0.3 lands about two sessions late. **Recommended:** move MongoDB and keep RabbitMQ (24 sessions). RabbitMQ is the cheapest (no credentials) and its "queue without consumers" reason is v0.4's best cross-signal example. In the owner's order (MongoDB before RabbitMQ), RabbitMQ would be the one to move.
  - **Checkpoint on 20 November:** if Redis, PostgreSQL, Nginx and the HTTP stats are not all done, the remaining integration moves to v0.5 as well. The launch date does not move.
- Consequences: the landing site's Applications section lists only what shipped. The catalogs of whatever moves stay in SPEC §4.12 for v0.5.
- Amended 2026-11-09 (owner's answers):
  - **Accepted.** Elasticsearch **and** MongoDB move out of v0.3: MongoDB ships as **v0.3.1** about a week after the launch, Elasticsearch in v0.5. RabbitMQ stays.
  - **Launch:** Wednesday 2 December if the timeline allows, otherwise 3 December. At 1.5 sessions a day, v0.3 is about 24 sessions (released about 25 November), v0.4 about 6 and launch preparation about 2: that ends on 1 December, so 2 December fits with no slack.
  - **The 20 November checkpoint** recalculates the pace and the date.
- Amended 2026-11-10: 0.3.1 is the fix release the live demo needed on its first day (RabbitMQ rates, health from findings, the layout); **MongoDB ships as 0.3.2**, still about a week after the launch.

## ADR-142: The demo shows Applications with real services and a real failure

- Date: 2026-11-09 · Status: accepted (owner, 2026-11-09)
- Decision:
  - **The live demo's sample app** (its private deployment kit) gains PostgreSQL, Redis, RabbitMQ and an ingress-nginx in the `shop` namespace, monitored through the seed file with `reference` credentials (ADR-133). The demo's chaos script adds service failures:
    - a consumer that gets OOM-killed every 30 minutes, so the queue grows without consumers;
    - a connection leak that pushes PostgreSQL near `max_connections`;
    - a burst of 5xx behind the ingress.
  - **Demo visitors** see Applications and every service page, read-only. Monitor and the connect flow are refused there, with the usual demo message.
  - **The kind e2e demo** (`deploy/test/k8s`) and the Docker demo host (`demo-up.sh`) get the same services, so tests and screenshots use the same failures.
- Consequences: the demo cluster needs about 600 MB more memory; the demo kit's limits grow accordingly.
- Amended 2026-11-09: **Accepted.** The demo gets PostgreSQL, Redis, RabbitMQ and an ingress-nginx; MongoDB joins with v0.3.1.
- Amended 2026-11-09 (as built, owner's request that a fresh dev stack shows live data with no manual step):
  - **Services in the seed file** (`services`: cluster kind and optionally name, type, the name as discovered, a `reference` access, default alerts on). The backend tries them at start and every minute, and monitors each one once its agents report it, once per cluster (`seed_services`), so a service someone stops monitoring isn't added back. One monitored by hand already keeps its access, unless it has none.
  - **The dev demo** (`deploy/test/demo-up.sh`): a `watchlog` role with `pg_monitor` in the kind `shop/postgres` (password in the Secret `watchlog/shop-postgres-watchlog`, with the Role and RoleBinding WatchLog writes for one Secret) and in a new Compose `storefront/db` (password in a root-owned file under the folder mounted as `/etc/watchlog/secrets`); both preload `pg_stat_statements`. `deploy/test/demo/seed.json` monitors `shop/redis`, `shop/postgres`, `storefront/cache` and `storefront/db`; `./dev.sh product` passes it to the backend.
- Amended 2026-11-10 (the live demo's kit, as built for 0.3.0):
  - **Services:** RabbitMQ 4.1 in `shop` with a publisher (3 messages a second) and a consumer; ingress-nginx in its own namespace with its metrics on, in front of `frontend` (the load generator comes through it); PostgreSQL with `pg_stat_statements` and a `watchlog` role (`pg_monitor`) whose password is only in a Secret the collector may read; Redis at its `maxmemory` with `allkeys-lru`. The seed monitors the four with their default alerts.
  - **Failures:** the consumer runs 25 minutes, is OOM-killed (a 256 MiB limit and `tail /dev/zero`), and its restarted container waits 6 minutes before consuming (a mark in an `emptyDir`): the queue grows with no consumers and the reason names it. The api outages (every 30 minutes) are 5xx bursts on the Nginx page. An hourly job holds 85 PostgreSQL connections for 8 minutes. Redis evicts all the time.
  - Tested piece by piece on a kind cluster; the 0.3.0 chart is the product's released one.

## ADR-143: Nginx as built: where each number comes from

- Date: 2026-11-10 · Status: accepted (v0.3 slice 10; owner's standing instruction to record defaults in pending-review)
- Context: SPEC §4.12 planned ingress-nginx's :10254 metrics "with nothing to set up". Measured on controller 1.12.1: `--enable-metrics` defaults to false and the Helm chart passes `controller.metrics.enabled` (false), so a default install serves only Go's own metrics. Request metrics are also dropped for hosts no Ingress names (`--metrics-per-undefined-host`).
- Decision:
  - **Source per service:** ingress-nginx with its metrics → its own series. Anything else (plain Nginx, OpenResty, ingress-nginx without metrics) → the node agents' eBPF HTTP server series (ADR-139) for the service's workload or container and its port, and its eBPF client edges for upstreams.
  - **Detection:** the collector asks `:10254/healthz` (ingress-nginx's health port) once per member every 10 minutes; `ok` means ingress-nginx, and whether `/metrics` has `nginx_ingress_controller_*` series means its metrics are on. The status's extra carries one row `nginx: [{flavour, metrics, stub_status, stub_missing}]`.
  - **ingress-nginx's series as they are**, with fewer labels: requests keep the Ingress's namespace, the Ingress, the backend Service and the exact status; the duration histogram and response sizes keep the first three (status summed); path, host, method, canary and the controller's own labels are summed away. Three labels are renamed because the collector sets them on every series: `namespace` → `ingress_namespace`, `service` → `backend`, a certificate's `host` → `tls_host`. The controller's own self-signed certificate (`host="_"`) is dropped. At most 4,000 series per member.
  - **When metrics are off:** the reason `ingress_metrics_off` carries the command: `helm upgrade <release> ingress-nginx/ingress-nginx --reuse-values --set controller.metrics.enabled=true` when the pods carry Helm's labels, else a `kubectl patch` adding `--enable-metrics=true`. The e2e runs it as shown.
  - **stub_status:** looked for at `/stub_status` and `/nginx_status`, on the service's port and on 8080 (the documented snippet's port, apart from traffic); remembered once found (per member name and address: a recreated container can reuse another's address); while missing, looked for again every minute for a new member's first 10 minutes, then every 10 minutes. The reason says what each place answered (`:8080/stub_status: 404`). That's the only request WatchLog makes to Nginx.
  - **Rules and lists:** eBPF series carry the workload, not the service, so the `nginx.*` catalog keys are built per service: ingress-nginx's series by `service`, the others' eBPF expressions given `service` and `service_type` with `label_set`. The rule's scope is resolved from the database at evaluation (as label selectors are, ADR-085); the list and MCP do the same.
  - **Upstreams:** Kubernetes: the backend Services (ingress-nginx) or edge Services (eBPF), ready when the Service has a ready endpoint (cluster-agent's Service status), plus ingress-nginx's `orphan_ingress{type="no-endpoint"}`. Docker: the containers and ports Nginx connects to, down when every connection in 5 minutes failed. A container upstream is named with its port.
  - **Error bursts:** an upstream at ≥ 5 % 5xx over the page's step (1 minute at most on the 1-hour range, not 10 s), "during rollout" when its workload had a rollout or image change up to 10 minutes before.
  - **Kubernetes and Docker (ADR-124):** plain Nginx is the same on both. ingress-nginx is a Kubernetes controller; on Docker it would be read the same way if its port 10254 is reachable.
- Consequences: the page's top-level reasons for ingress-nginx depend on the user enabling metrics for connections and certificates; requests, errors and latency don't. The service page's 15-second cache key includes a hash of the collector's extra, so a found stub_status or metrics turned on shows at once.

## ADR-144: Alert rules for every service of a type

- Date: 2026-11-10 · Status: accepted (the owner's request: "alert rules that cover every instance of a type")
- Decision:
  - A threshold rule's scope can be `{ "serviceType": "redis" }` (or postgres, nginx…) instead of one `service`. It covers every monitored service of that type in every cluster (or one cluster, with `clusterId`), now and added later: the query matches `service_type`, which the collector sets on every series, and Nginx's eBPF series are resolved per service as for one (ADR-143).
  - The metric must be generic (`service.*`) or the type's own (`redis.*` for Redis). One service and a type together are refused.
  - Each service fires its own alert, named after the service, as one-service rules do.
  - The rule drawer on a service's page offers "this service" or "every <type> service"; the rule list says "every Redis service".
- Consequences: default rules stay per service (created when monitoring starts, ADR-136); a type-wide rule is something people add.

## ADR-145: RabbitMQ as built: the plugin's series, and the consumer that was lost

- Date: 2026-11-10 · Status: accepted (v0.3 slice 11; defaults in pending-review)
- Measured: RabbitMQ 4.1.8 (official image, with and without `-management`) has `rabbitmq_prometheus` on by default. `/metrics` gives each node's totals without labels; `/metrics/detailed` gives per-queue families on request (`queue_coarse_metrics`, `queue_consumer_count`, `queue_delivery_metrics`, `queue_exchange_metrics`).
- Decision:
  - **What is read:** each node's `/metrics` every scrape (messages, consumers, connections, the `rabbitmq_global_messages_*_total` counters, memory and its watermark, disk and its limit, file descriptors, Erlang processes, alarms; version and node names from the info series), and on the heavy scrape the four detailed families. Names are the plugin's own; per queue `rabbitmq_detailed_queue_*` with `vhost` and `queue` (the exchange label summed away). The 200 deepest queues per node, plus every queue with messages and no consumer. The light scrapes repeat the last per-queue values.
  - **The plugin check:** a node whose AMQP port answers and whose :15692 doesn't is up with its plugin off; the reason `prometheus_plugin_off` carries the command per node (`kubectl exec -n <ns> <pod> -- rabbitmq-plugins enable rabbitmq_prometheus`, `docker exec <container> …`). The e2e runs it as shown.
  - **The lost consumer:** the plugin doesn't say which client consumes which queue (that needs the management API and a user). So `queue_no_consumers` links the clients that were connected to RabbitMQ's AMQP port in the last 24 hours (eBPF flows, WatchLog's own excluded) and ended since: a pod crash-looping or with a recent last termination (its reason: OOMKilled, Error…), a container that exited (OOMKilled when Docker says so), restarted, or is gone; closest first to the moment the queue last had a consumer. The words say "connected to RabbitMQ until then", not "consumed it".
  - **Node down:** a member that doesn't answer is the generic `member_down`; the default rule "RabbitMQ node down" uses `service.reachable.ratio < 1` (critical after a minute).
  - **Rules:** `rabbitmq.queue.unconsumed` is per queue (ready messages of a queue with no consumer that grew over 5 minutes), so each queue fires its own alert.
- Consequences: the link is only as good as the flows: with network flows off, the reason names the queue and when it lost its consumers, without a client.

## ADR-146: Probable cause: deterministic rules over the signals WatchLog already has

- Date: 2026-11-10 · Status: proposed (v0.4 planning; waits for the owner and the mock-ups)
- Context: v0.4 answers "Why is this broken?" for every alert and every failing edge (roadmap §7). It is the last release before the launch on 2–3 December, so it must build in about a week, with no new collection in the agent.
- Decision:
  - **Subjects:** what a cause is asked for. An alert; a service-map edge; a workload or pod (Kubernetes); a container or Compose service (Docker); an application with an active finding (ADR-137).
  - **Evidence:** gathered on demand from data stored today:
    - the subject's state: phase, ready replicas, restarts, last termination reason and exit code, OOM kills against the memory limit, waiting reasons (ImagePullBackOff, CrashLoopBackOff), CPU throttling;
    - its events, and the change markers in the 60 minutes before the problem started (ADR-128): rollouts, image changes, scaling, nodes; on Docker, re-created containers, image changes and Compose changes;
    - the node or host under it: NotReady, pressure conditions, disk, a host that went silent;
    - its outgoing edges on the service map: failed and refused connections, connect latency, HTTP 5xx and latency (ADR-139), and DNS NXDOMAIN with search-path misses left out;
    - the active findings of any application it talks to (ADR-137, ADR-145).
  - **Rules:** a fixed catalog in the backend (ADR-150). Each rule says which subjects it applies to. It turns evidence into a cause with an evidence chain: ordered steps, each a sentence with its time and a link to the object, e.g. "cart can't reach catalog → catalog has 0 ready pods since 19:21 → catalog was scaled to 0 at 19:21".
  - **Following dependencies:**
    - when the subject's own evidence doesn't explain it, the engine follows its failing or slow outgoing edges, at most two hops;
    - it asks the same rules of the workload, container or application at the other end;
    - a deeper cause that fully explains the symptom ranks above a shallow one.
  - **Ranking:**
    1. the strength in words (ADR-147);
    2. whether the cause began before the symptom: within the window first, then at the same time;
    3. a complete chain over a partial one;
    4. fewer hops;
    5. the catalog's order.
       At most three causes are returned.
  - **Where it runs:** a backend module (`causes/`) of pure functions over an evidence snapshot, so every rule is unit-tested from fixtures. Results are cached for 15 s per subject, as findings are. Nothing new is stored. Notifications compute the cause once, when an alert fires (ADR-148).
  - **No AI in the product.** Users who want an AI to reason further reach the same evidence through MCP (ADR-148).
- Consequences:
  - The answer is only as good as the signals. With network flows off, dependency rules can't run, and the answer says so.
  - Causes are worked out again from the data still retained (default 15 days), so an alert from last week can still be explained.
  - Anomaly correlation (grouping anomalies that start within 5 minutes of each other across the map) stays Enterprise, in Phase 7, and builds on this.

## ADR-147: Confidence in words: likely, possible, or no clear cause

- Date: 2026-11-10 · Status: proposed (v0.4 planning)
- Decision:
  - **Likely:** one rule matched with a complete chain, and the cause began before the symptom (or with it) inside the window. At most one cause is likely.
  - **Possible:** a partial chain; a cause that began after the symptom; or a second cause as strong as the first. The words then say "possibly" and show both.
  - **No clear cause:** nothing matched. WatchLog lists what it checked (restarts, events, changes, the node, dependencies, applications) and the facts it found, so the reader starts from there, never from a blank.
  - There are no percentages or scores, in the UI, the API or MCP: a number suggests a precision the rules don't have.
  - Each sentence is a structured code plus facts. The UI renders it through i18n, as findings are (ADR-137), and the finding-template test (every placeholder filled) covers it.
- Consequences: when two causes tie, the reader sees both, honestly marked "possible". The catalog's rule order is the tie-breaker, and the docs list it.

## ADR-148: Probable cause in the UI, the REST API, MCP and notifications

- Date: 2026-11-10 · Status: proposed (v0.4 planning; the screens wait for mock-ups)
- Decision:
  - **REST:**
    - `GET /api/v1/causes?cluster=<id>&subject=<kind>:<ref>` returns `{ subject, checked[], causes[] }`. Each cause has `strength` (likely or possible), `code`, `facts`, `since` and `chain[]` (steps with code, facts, time and an object link). The subject kinds are alert, edge, workload, pod, container, compose_service and application;
    - additive and optional fields: `likelyCause` (the top cause, short) on the alert detail, on each Needs-attention problem, and on an application that has a finding. The public OpenAPI gains only optional fields and one new route.
  - **MCP:**
    - `explain_alert` gains `causes`. Its description stops saying "WatchLog does not guess a cause" and says "ranked probable causes with their evidence; treat 'possible' as a lead to check";
    - a new tool, `explain_problem`, takes a subject (a workload, pod, container, Compose service, edge or application) and returns the same answer;
    - `get_problems` carries each problem's `likelyCause`. That makes 14 tools.
  - **UI:**
    - one "Likely cause" panel (the ranked causes, each chain as steps with times and links, and "What we checked");
    - it appears on the alert detail page, the service-map edge panel, the workload and pod pages, the Docker container and Compose service pages, and the application page beside a finding;
    - one line under each item in the overview's Needs attention.
  - **Notifications:**
    - Slack, Telegram and email get one "Likely cause:" line when a cause is likely (none when it is only possible), worked out when the alert fires, with a 2-second budget, after which the message goes without it;
    - the webhook payload gains an optional `likelyCause` object.
- Consequences: the REST route and MCP give API users and AI clients the same evidence the UI shows. A cause in a sent message is a snapshot, while the alert's page shows today's answer.

## ADR-149: Probable cause on Docker hosts, as on Kubernetes

- Date: 2026-11-10 · Status: proposed (v0.4 planning; ADR-124)
- Decision: every rule has a Docker form, in Docker's words:

  | Kubernetes                                       | Docker host                                                                      |
  | ------------------------------------------------ | -------------------------------------------------------------------------------- |
  | pod restarts, CrashLoopBackOff, last termination | container restarts and exit code, restart policy looping, health check unhealthy |
  | OOMKilled against the memory limit               | the `oom` event and exit 137, against the container's memory limit               |
  | rollout or image change before the problem       | the container re-created, a new image, a Compose project change                  |
  | dependency scaled to 0 or with no ready pods     | dependency container stopped or exited, Compose service with 0 running           |
  | node NotReady, pressure, drained                 | the host went silent, host memory or disk nearly full                            |
  | edges: refused, failed, slow, NXDOMAIN, HTTP 5xx | the same, from the Docker agent's eBPF map                                       |
  | application findings                             | the same (the collector runs on the host, ADR-131)                               |

- **Kubernetes only, with the reason:**
  - ImagePullBackOff and FailedScheduling have no Docker form: a Compose `up` that can't pull or start a container fails on the operator's terminal, and no container ever reaches the agent;
  - HPA scaling has no Docker form either.

  These two rules don't run on a Docker fleet. The docs say why.

- Consequences: the kind e2e and the Docker host e2e prove the same list of failures. A Docker failure in that list either has its Docker scenario or cites this ADR.

## ADR-150: The v0.4 cause catalog, and what is cut to keep the date

- Date: 2026-11-10 · Status: proposed (v0.4 planning)
- Decision: the catalog, in tie-break order:
  1. `dependency_down`: what the subject calls has nothing ready (scaled to 0, every pod failing, the container stopped).
  2. `bad_change`: a rollout, image change or re-create of the subject, or of its dependency, within the window before the problem, and the new version is failing.
  3. `oom_limit`: OOM-killed with the working set at the limit ("the 256 MiB limit is reached in about N minutes").
  4. `crash_exit`: exits with a code (Error, code N), with its last events.
  5. `image_pull` (Kubernetes): cannot pull the image (bad tag or registry).
  6. `unschedulable` (Kubernetes): FailedScheduling, with its reason (CPU, memory, taints).
  7. `node_or_host`: NotReady, pressure, drained or cordoned; on Docker, the host is silent or full.
  8. `application_finding`: a dependency is a monitored application with an active finding, e.g. "api is slow → api waits on PostgreSQL → connections at 98 % of max_connections, 85 held by shop/nightly-export". RabbitMQ's lost consumer links on to that consumer's own cause.
  9. `connection_refused`: the dependency's port refuses connections.
  10. `dns_nxdomain`: a name that doesn't resolve, with search-path misses left out.
  11. `cpu_throttled`: the subject is throttled for more than 25 % of the time while it is slow.
  12. `job_failed`: a Job or CronJob run failed; its exit and its backoff.
- Cut from v0.4, to keep the launch date:
  - anomaly detection and correlation;
  - learned baselines, and numeric scores;
  - any AI or LLM in the product;
  - chains deeper than two hops; causes across clusters;
  - stored history of causes, and feedback on them ("was this right?");
  - rules users write, and per-rule settings;
  - a cause for a custom metric rule with no object (it gets "What we checked" and the changes before it);
  - logs and traces (SPEC §2.5);
  - new agent probes (TCP retransmits and resets stay P1);
  - MongoDB and Elasticsearch rules: they join with their integrations, through `application_finding`, with no new rule;
  - new notification channels;
  - a site feature page (a home card and a docs page only).
- Consequences: twelve rules, each with unit fixtures, and each scenario in the "Done when" list proven on kind and on a Docker host (the v0.4 plan in the notes).
- Amended 2026-11-11 by ADR-161: the site feature page is built after all (the owner's review).

## ADR-151: Community holds any number of clusters, Docker fleets and nodes

- Date: 2026-11-10 · Status: accepted (the owner's decision; supersedes ADR-039)
- Context: ADR-039 limited Community to one cluster or Docker fleet (409 `cluster-limit`). Teams run Kubernetes and Docker side by side (ADR-124). The limit made the free product look incomplete. In practice it only bit the second cluster of a self-hoster, the person most likely to recommend WatchLog.
- Decision:
  - **No cluster limit in Community.** `POST /clusters` creates any number of Kubernetes clusters and Docker fleets on every plan; the `urn:watchlog:problem:cluster-limit` problem type is gone.
  - **Cloud plans:** they keep their own limits for Phase 5, where SPEC §3.2 sets them (Cloud Free: one cluster, up to 5 nodes).
  - **The cluster switcher** is all a Community user needs to move between clusters.
  - **A unified "all clusters" overview stays a later Cloud and Enterprise feature** (SPEC §3.2, §4.10).
- Consequences:
  - SPEC §2.3, §3.1, §3.2 and §4.10 are updated, and so are the README, the FAQ, the install guide ("More clusters and Docker fleets") and the site's pricing.
  - Tests no longer switch the org to `pro` to hold two clusters.
  - Lifting a limit takes nothing away (SPEC §3.1, rule 3), so no migration is needed. Existing installs simply stop answering 409.

## ADR-152: Probable cause on the object: what the rules count, and which wins when two apply

- Date: 2026-11-10 · Status: accepted (v0.4 slice 2; details inside ADR-146 to ADR-150)
- Context: the rules on the object itself (`bad_change`, `oom_limit`, `crash_exit`, `image_pull`, `unschedulable`, `job_failed`) read the same failure from several angles, and the API's own numbers don't fit a window: Docker events are aggregated per container and reason since the first one, `restartsInRange` always covers the hour before now, and a re-created container's change marker went missing when a delta stored the new container first (measured on the e2e demo).
- Decision:
  - **Counts cover the counted hour:** the window's last 60 minutes, to its end (now, or when the alert resolved), read through the curated `POST /query/range`: restarts from the restart counters, Docker OOM kills from the new `container.oom_kills` metric (the agent's oom-events counter, +1 per kill), memory from the working set. Sentences say "in the last hour". Without the metrics a rule falls back to the object's own numbers only while the window ends now, else says less (no count).
  - **The memory trend is said only when the data shows it:** two runs or more that climb from well below the limit to near it and end in a drop, at growth rates within a factor of two. Otherwise "limit reached" comes from the termination reason alone (scrapes every 15 s miss the peak).
  - **One cause, not two, for one failure:** a rule whose chain contains another's cause covers it on the same object (`bad_change` and `job_failed` cover `crash_exit` and `oom_limit`), so ranking never ties them into two "possible" causes.
  - **A new image that can't be pulled is `image_pull`'s,** with the change that set the image as where it starts; `bad_change` takes a new version that crashes or is OOM-killed. A rollout's new pods are those created within 15 minutes of it; a Docker re-create's is the container created within 3 minutes of the marker.
  - **Not a crash:** exit 0; on Docker, a container stopped by a signal (137 without an OOM kill, 143) with no restart by its policy, or one running again without such a restart.
  - **Not `oom_limit`:** a kill without a memory limit (the node or host ran out). Under node memory pressure or on a nearly full host the chain is partial (possible at best).
  - **`unschedulable` and a cordoned node:** when the scheduler names cordoned nodes, the cordon is where it starts; `unschedulable` then gives a partial chain, so `node_or_host`, with the cordon in its complete chain, ranks first.
  - **Timing of a failure of the object itself:** it began with its earliest evidence (first restart in the hour, first back-off event, termination). When the counted hour starts after the symptom, a first restart after the symptom says nothing, so the start is unknown rather than "after".
  - **Docker has no Jobs:** a one-shot container that exited non-zero is `crash_exit` ("exited with code N and stays stopped"); `image_pull`, `unschedulable` and `job_failed` run on Kubernetes only (ADR-149).
- Consequences: the public API gains one metric key (`container.oom_kills`), an additive change. A Docker crash loop whose process runs a while before it exits is now a "keeps restarting" problem in Needs attention (restarted by its policy within 2 minutes of its end, in the last 5 minutes, 3 restarts or more), so its cause has a symptom to sit under.

## ADR-153: Probable cause across the map: what the far end sees, the Docker stop, and which rule a slow change is

- Date: 2026-11-10 · Status: accepted (v0.4 slice 3; details inside ADR-146 to ADR-150)
- Context: the rules across the map (`dependency_down`, `connection_refused`, `dns_nxdomain`, `application_finding`, and `bad_change` for a dependency) read two objects at once: the caller and what it calls. Measured on the e2e demos: on Kubernetes a Deployment scaled to 0 leaves its Service without endpoints, so the caller's connects fail; on Docker a stopped container's name leaves Docker's DNS, so its callers never connect at all (no failed connect, only failed lookups, answered SERVFAIL by Lima's resolver, and an edge that goes quiet); the agent counts a connect that ends unestablished without telling a refusal from a timeout; DNS rows carry rcode counts per client, never the name; RabbitMQ's "no consumers since" was always null on the demos.
- Decision:
  - **The far end knows the edge.** The walk gathers the dependency's own evidence with the edge that led there (`via`) and that edge's last hour (one read of `GET /service-map/edge`: when its failures or its slowness began, its last connection). The rules across the map run there, so each one sees both ends. A cause found through an edge explains the caller's dependency check (and its DNS check, for the lookup form), never the caller's own checks.
  - **The walk goes on past a call's cause.** A complete cause on the object itself stops the walk; `dns_nxdomain` and `application_finding` don't, since what is called, or the object a finding names, may explain them better. A cause further on may cover a rule on the caller (`dependency_down` behind a stopped Docker container covers the caller's `dns_nxdomain`). An application's finding that names an object (RabbitMQ's consumer, PostgreSQL's top connection holder) is followed like an edge and counts as a hop. Still at most two hops, one likely cause, three causes, three steps.
  - **`dependency_down`:** at the far end only. Kubernetes: the workload has no ready pods; scaled to 0, the scale marker is where it starts; otherwise the dependency's own cause (the object rules) ends the chain and is covered by it. Docker: no container of it runs, and the caller shows it: failed connects, failed lookups, or an edge with no connection for 2 minutes (slice 0, gap 3). Nothing ready is itself the evidence: the chain is complete without a deeper cause.
  - **`connection_refused`:** at the far end of an edge whose connects fail while the dependency runs (ready pods, running containers): nothing accepts connections on that port. The words say "fail", not "refused", since refusals and timeouts look the same to the agent; the chain is partial while half or more of the connects still succeed.
  - **`dns_nxdomain`:** NXDOMAIN answers only, at least 2 a minute and 5 % of the lookups, search-path misses left out (ADR-113). SERVFAIL and timeouts don't count: they are the resolver's trouble, some upstream resolvers answer SERVFAIL for any single-label name (Lima's), and a stopped Docker dependency fails that way too. The failing name isn't recorded, so the words never name it and give no "closest" name (the owner's call: drop the hint when the name is unknown). When the failures began comes from a new curated metric, `dns.nxdomain.rate`.
  - **`application_finding`:** the application's most severe finding (critical, then warning). On an application subject, the finding alone is a partial chain (it says what, not why); followed to the object it names it is complete: the consumer's own cause, or how it ended, and the holder of the connections with when it started. At the far end of a failing or slow edge, the finding explains the caller. An alert on a monitored application (labels `service` and `service_type`) is about the application.
  - **A slow or erroring dependency after its change is `bad_change`,** not "edge latency": a version change of the dependency at most 15 minutes before its edge turned slow (p95 ≥ 1 s) or erroring (5xx ≥ 1 %), and no later than a minute after, from the edge's last hour. A slow edge with no change before it stays a "possible" dependency check (`cpu_throttled`, slice 4, may explain it). Without the edge's history the chain is partial.
  - **Chains:** the dependency's or consumer's own steps follow the rule's own, at most three in all: restart counts go first, then supporting details (the memory trend, the last warning), then the earliest steps.
- Consequences:
  - The public API gains one metric key (`dns.nxdomain.rate`), an additive change; the checks gain `dependencies_quiet` (it called services in the last hour and calls none now).
  - Each followed edge costs one more read (its last hour), and a dependency monitored as an application two more.
  - A `kubectl rollout restart` can't be told from a new version (the rollout marker carries only the revisions): a dependency or consumer restarted that way and failing after it reads as `bad_change`.
  - RabbitMQ's missing "since" was the e2e fixture's: its consumer declared the queue unlike the publisher (PRECONDITION_FAILED) and never consumed. The fixture is fixed; a missing time still leaves the step without one, and the cause's time is the consumer's own cause's.

## ADR-154: Probable cause under the object: the node or host, the CPU, and a dependency slower than usual

- Date: 2026-11-10 · Status: accepted (v0.4 slice 4; details inside ADR-146 to ADR-153)
- Context: the rules under the object (`node_or_host`, `cpu_throttled`) read what the node, the host and the CPU limit do to a pod or container. Measured on the e2e demos: a `kubectl drain` leaves the node `unschedulable` with the taint `node.kubernetes.io/unschedulable`, the pinned pod Pending with FailedScheduling "1 node(s) were unschedulable" (during an uncordon it briefly reads "untolerated taint(s)" instead), and the node's events NodeNotSchedulable and NodeSchedulable, aggregated per reason, the newest time last; there is no change marker for a cordon. A Docker host whose agent stopped keeps its containers' last state, and turns `inactive` 3 minutes after its last report. The agent records only throttled CPU seconds (no CFS periods): a busy loop at a 20m limit measured 0.8–1.0 s/s on kind and 1.08 s/s on Docker, while ADR-072's throttled-per-used ratio read 40. The caller's calls to that container went from about 1 ms to 200–230 ms at p95, under the 1 s "slow" bar the walk followed edges at, so no rule was reached.
- Decision:
  - **`node_or_host` on Kubernetes** (pods and workloads):
    - **held off a node:** a Pending pod whose FailedScheduling names cordoned nodes or taints, while a node is cordoned, not Ready or under pressure. The cordon's time is the newest NodeNotSchedulable, unless a NodeSchedulable came after it. Only for such a pod is one more read made (the nodes list, then the held nodes' detail). The words say "cordoned": a drain can't be told from a cordon. The chain is complete, and covers `unschedulable` (its partial chain, ADR-152), unless the scheduler also finds other nodes short of CPU or memory: the held node might be too, so this chain is partial and `unschedulable` gives the request as the reason, complete (this refines ADR-152, where a named cordon was always where it starts: a pod asking for 64 CPUs stays "no node has that much free" while a node is drained);
    - **a node not Ready** under the pod: complete, since the Ready condition changed;
    - **evicted** for the node's sake: the kubelet's message says "The node was low on resource: …". A pod over its own ephemeral-storage limit is not this rule's;
    - **OOM-killed for the node's sake:** with no memory limit (only the node can have run out), or under MemoryPressure while the working set seen stayed below half its limit. Both cover `oom_limit`. Under pressure near the limit, both chains stay partial, so both are possible;
    - **a node under pressure** under a pod that fails some other way: a partial chain, a lead.
    - The WatchLog agent's own silence on a node isn't a cause: the pods' state comes from the API server, and a node that stops reporting there turns NotReady (Unknown).
  - **`node_or_host` on Docker** (containers and Compose services):
    - **the host went silent** (status `inactive`): every container on it, complete, since its last report. What WatchLog shows of the container is from before, and the words say so. As a complete cause on the object, it stops the walk;
    - **OOM-killed for the host's sake:** no memory limit, or the host at 90 % memory or more while the working set stayed below half its limit (it covers `oom_limit`);
    - **a nearly full host** (memory or disk at 90 % or more) under a container that restarts or exited non-zero: partial;
    - Docker has no cordon or drain (slice 0, gap 4): nothing stands for one.
  - **`cpu_throttled`** (both platforms, any object with a CPU limit):
    - **the share:** throttled seconds a second, at most 100 %, the mean of the series' last 5 minutes, from 25 % (ADR-150, the default alert's threshold). It is exact for a single-threaded process and overstates a process throttled on several CPUs at once; there is no period counter to do better. When the throttling began is the current run of 1-minute means at 25 % or more. Gathering reads it once more per object with a CPU limit (`pod.container.cpu.throttled`, `container.cpu.throttled`);
    - **at the far end of an edge** the walk followed because it is slow, answers 5xx, or rose well above its usual p95 (below): complete when the throttling began before the slowdown or with it, or both last the whole hour. Failed connects are `dependency_down`'s or `connection_refused`'s;
    - **on the object itself:** complete only when the symptom is the throttling (the "Container CPU throttling" alert) or a caller's calls to it are slow or failing with 5xx; otherwise a partial chain, a lead.
  - **The walk follows a dependency slower than usual,** not only one past the 1 s bar: an edge whose current p95 is at least 50 ms and at least 5 times its usual p95 (the lower quartile of its last hour), in a run that lasts to now. Only edges at 50 ms or more have their hour read for it. A p95 that has been high for most of the hour is its usual, and is not followed. The edge's step says "slowed from 0.9 ms to 233 ms at p95"; the caller's dependency check says `dependencies_slower`.
  - **"What we checked" gains the CPU** (topic `cpu`: not throttled, throttled N % of the time, no CPU limit, no data), an additive value in the public schema.
- Consequences:
  - A followed edge to a slower dependency costs the read it always did; a pending pod held off nodes costs one or two more; an object with a CPU limit costs one more metric read.
  - `bad_change`'s dependency form still needs the 1 s bar or 5xx: a change that makes a dependency slower but under 1 s isn't matched yet.
  - On the live demo, slow-backend rolls out backend with a random delay and a 20m CPU limit at once, so `bad_change` and `cpu_throttled` may both be complete at the far end, and then tie: both possible, as the mock-up's "possible" panel shows.
  - Recorded answers from before this slice replay without the throttling read (it answers no series).

## ADR-155: The likely cause in the other answers and in MCP: its short form, bounded lists, and codes without rendered sentences

- Date: 2026-11-10 · Status: accepted (v0.4 slice 5; details inside ADR-146 to ADR-148)
- Context: ADR-148 adds an optional `likelyCause` ("the top cause, short") to the alert detail, each Needs-attention problem and an application with a finding, `causes` to MCP's `explain_alert`, a new `explain_problem` and `likelyCause` in `get_problems`; it doesn't fix the short form, how a list stays fast, or what MCP clients get in words. Measured on the e2e backend with every slice 2–4 scenario triggered (alert worker on): one uncached answer takes 20–75 ms (about 10–20 in-process reads); the kind overview listed 16 problems (15 with a likely cause), the Docker one 20 (15), `/applications` 8 services (4 with a finding). The dashboard refreshes the overview every 15 s, as long as the answer cache lasts, so each refresh is mostly uncached. The engine reads the overview, the alert and the applications itself (the symptom's start, the alert's labels, the findings). In-process reads made with a session or demo cookie came from the backend's own address, so in demo mode they all drew on one per-visitor query budget (120 a minute) shared by every visitor. `get_problems` with the full short form on each of 16 problems weighed 15.5 KB of MCP's 16 KB.
- Decision:
  - **The short form** is `{rule, code, facts, since, headline, subject}`: the top cause's rule, code, facts and start, the answer's headline (the line the Needs-attention mock-up shows), and `subject`, which `GET /causes?cluster=<id>&subject=<subject>` takes for the chain and the checks. It is there only when the answer is likely; possible, none and an answer not ready in time leave it out. It sits on the problem item, at the top of the alert detail (beside `alert`), and on the application (list and detail) when it has a finding.
  - **What a problem is asked as:** its alert (`alert:<id>`); else a Kubernetes pod (`pod:<ns>/<name>`) or a Docker container (`container:<host>/<name>`). Nodes and volumes are no subject (ADR-146) and get none.
  - **Bounded lists:** one `CausesService` per backend holds the 15 s cache that `GET /causes`, the fields and MCP share. A list explains its first 20 subjects (problems come worst first), each once, 4 at a time, and at most 8 uncached answers run in the whole process; the reads every answer repeats (the overview, the alerts, the lists) are made once per list. A list waits at most 2 s: an answer not ready by then is left out of that response, and one already started still fills the cache for the next refresh.
  - **No cause asks for causes:** the engine's in-process reads send `x-watchlog-no-cause: 1`, and the overview, the alert detail and the applications then leave the field out. Any caller may send it.
  - **In-process reads are marked as such** for cookie callers too (the token callers' internal-call mark, ADR-127): the demo's per-visitor query limit counts the request that made them, not each read, and `GET /causes` joins the routes it counts.
  - **MCP:**
    - `explain_problem` takes `subject` in `GET /causes`'s forms (a problem's `subject` from `get_problems`, or a chain step's `kind:ref`) and an optional `cluster`, and returns the answer: subject, object, symptomSince, resolvedAt, state, headline, causes, checks, flowsOff. That makes 14 tools.
    - `explain_alert` gains `causes` (the same evidence; null when it couldn't be worked out, and the facts come anyway). Its description no longer says "WatchLog does not guess a cause".
    - `get_problems` gives every problem its `subject`, and a likely one a shorter `likelyCause`: `{rule, headline, since}`. That keeps 50 problems inside 16 KB (the 16 above weigh 11.3 KB); `explain_problem` has the rest.
    - Every cause carries `means`, the rule's meaning in one sentence without a name. Facts and objects pass through ADR-129's cleaning.
    - The descriptions say the causes come from fixed rules over collected data, with no score, and that "possible" is a lead to check.
  - **Codes and facts, no rendered English:** MCP gets what `GET /causes` gives. The backend can't render the dashboard's sentences: they live in the web bundle's `en.json` (the backend image builds only `backend/`), and several facts are formatted by the web's helpers (bytes, cores, durations, the findings' own sentences). A rendered sentence would also put cluster names inside WatchLog's words, which ADR-129 rules out for MCP. The rule's `means` and the codes, which name what they say (`dependency_down_scaled`, `node_or_host_held_cordoned`), give the AI client enough to write its own sentence.
- Consequences:
  - Measured after (median of 4 rounds, cache expired, e2e backend): the kind overview 46 ms without the field, 202 ms (at most 246) with it uncached, 14 ms cached; Docker 21 → 139 ms (at most 163), 11 ms cached; `/applications` 26 → 59 ms (at most 82), 4 ms cached.
  - A problem without `likelyCause` may still have possible causes: the Needs-attention mock-up's "Possible" and "No clear cause" chips need `GET /causes` per row, or a later additive field.
  - In demo mode, a visitor's `GET /causes` now counts toward the visitor's 120 queries a minute.
  - Notifications (slice 7) need an English line in the backend: they render it there, from the headline's code and facts, the way alert texts are written today.

## ADR-156: The probable-cause panel in the dashboard, and the Needs-attention line's state

- Date: 2026-11-11 · Status: accepted (v0.4 slice 6; details inside ADR-147 and ADR-148, the v0.4 mock-ups)
- Context: ADR-148 puts one panel on six pages and one line under each Needs-attention item. The mock-ups show the line with a Likely, Possible or No clear cause chip, but `likelyCause` (ADR-155) carries only likely causes, so a row without it could be possible, none, or not worked out in time. Several pages ADR-148 names don't exist as such: a workload's page is the Workloads page's Pods view with an owner (`?wkind=&wns=&wname=`), and a Compose service has no page at all. Measured on the e2e backend with the slice 2–4 scenarios triggered: one Needs-attention list held likely, possible (a cordon that began after the pod's alert) and no-clear-cause rows on both platforms; `GET /causes` answered in 20–75 ms uncached, and a healthy pod answers "no clear cause" with no symptom.
- Decision:
  - **The line's state is in the overview:** each problem whose cause was worked out in time gets an optional `causeState` (`likely`, `possible`, `none`) and, with no likely cause, up to two `possibleCauses` (`{rule, code, facts, since}`), from the same bounded `CausesService` list as `likelyCause` (`summaries()`; `likely()` is built on it). Additive in the public OpenAPI. MCP's `get_problems`, the alert detail and the applications keep `likelyCause` only, and notifications stay likely-only (ADR-148).
  - **The line:** the chip, then the likely cause's headline; for possible, the possible causes' one-line sentences (`causes.cause.<code>`) joined with " · "; for none, one sentence that points to the checks. No line when the cause wasn't worked out (past the first 20, after 2 s, a node or a volume).
  - **The panel, one component** (`CausePanel`), always in this order: the headline; the likely cause's chain (at most 3 steps, symptom on top, the last step marked "Where it starts"; each step with its Kubernetes, Docker or service logo, the source chip, the fact, its time, a link to the object, and the `next` connector between steps); "Also possible" for the other causes ("Leads to check" when none is likely); the resolution line for a resolved alert; "What we checked" as a native `<details>`, closed when a cause is likely or possible and open when none is clear; the footer with the MCP tool that gives the same answer (`explain_alert` on an alert, `explain_problem` elsewhere). It reloads every 30 s like the pages around it.
  - **Chips say how sure, never how bad:** Likely (the info token), Possible, No clear cause and Was likely (neutral). Red and amber stay for severity. A possible-only answer's chip says "Possible".
  - **"What we checked" counts what applies,** as the headline does ("We checked 5 things"): checks that don't apply are listed, not counted.
  - **Where it sits:** above the chart on the alert detail; near the last termination on the pod page; above the pods of a workload's Pods view; under the diagnosis on the Docker container page; on the Containers page filtered to one Compose service (`?project=&service=`, the link a chain step gives, and the container page's Compose fact); beside the finding on the application page (only with a finding); compact in the service map's edge panel (only for a failing or slow edge). On the object pages it stays hidden when there is nothing to explain: no symptom, no cause and no check that explains or is a lead.
  - **Compact form** (the edge panel, about 380 px): the headline and the chain only.
  - **Loading, error:** a skeleton marked busy until the first answer; an error is one line with Retry inside the panel and never touches the rest of the page (hidden on the object pages).
  - **"Copy as text"** puts the headline, the numbered chain with its connectors and times, the possible causes and the resolution in plain words on the clipboard, for an AI chat or a ticket; the button says "Copied".
  - **The alert detail also shows** the chain's moments (a change, a kill) as info-coloured lines on the alert's chart, and an "Ask your AI" card with `explain_alert(id: "<the alert's id>")`.
- Consequences:
  - The overview's payload grows by the possible causes of at most 20 problems; no extra work, since the answers were already computed for `likelyCause`.
  - Left for later: "What was sent" on the alert detail (slice 7's notifications); the DNS step's "closest name" hint (ADR-153: the name isn't recorded); a light theme (the dashboard is dark only, SPEC §11).

## ADR-157: The likely cause in the notifications: worked out once as the alert fires, read by the worker in-process, in words the web and the backend share

- Date: 2026-11-11 · Status: accepted (v0.4 slice 7; details inside ADR-148 and ADR-155)
- Context: ADR-148 adds one "Likely cause:" line to Slack, Telegram and email, and `likelyCause` to the webhook, worked out when the alert fires within 2 s. Three things stood in the way. The alert worker had no Fastify app, while probable cause reads the public API in-process as its caller (ADR-146, ADR-155). The backend had no copy of the headlines, which lived in the web's `en.json` (ADR-155). And a resolved alert's message needs a rule for "was likely". Measured on the e2e backend (kind and Docker, the worker beside it): working out an alert's cause took 122–492 ms, median 166 ms, over the six alerts of the first notification run.
- Decision:
  - **When:** just before an alert's firing (or escalation) message is sent, the delivery loop asks `GET /causes`'s engine about `alert:<id>`, once per alert whatever the number of channels, with 2 s for all the alerts of one org in the batch (orgs side by side, the bounded `CausesService.answers()` of ADR-155). The answer is kept with the alert (`alert_states.cause`: state, how long it took, and the likely cause; `cause_at`), first one wins when two workers send. Not ready in time is kept as `late`: the message goes without the line, never late, and the line is not added afterwards. The message stored for delivery carries what was sent, so a retry says the same.
  - **Which messages:** the firing, escalation and reminder messages carry the line when the kept answer is likely; possible, none and late add nothing (ADR-148). Flapping and test messages never do.
  - **The resolve says "Was likely: <headline>" from the answer kept at fire time,** not from a new one: it repeats what the firing message said, costs no second 2 s, and doesn't depend on today's state of an object that may have changed since (slice 1's gap). A firing message that went without the line has a resolve without it.
  - **The line** is `Likely cause: <the answer's headline>`, under the alert's facts and before its link, in all four channels (Slack and Telegram escape it as the rest of the text). The headline names the subject and the cause ("web fails because api was scaled to 0: nothing answers its calls."); the mock-up's examples were worded differently.
  - **The webhook:** each alert of the payload gains an optional `likelyCause` (a message can hold up to five alerts, so it sits on each alert, not at the top as in the mock-up): ADR-155's short form `{rule, code, facts, since, headline, subject}`, plus `text` (the line's words) and `chain` (`[{subject, name, fact, facts, since | at}]`, symptom first, `fact` the step's code). On firing, escalated, renotify and resolved events. `version` stays 1: the change is additive.
  - **The worker reads through an in-process app:** it builds the backend's app without listening (`buildApp` with `serviceReads`) and reads the public API with `app.inject`, as MCP and probable cause do in the backend, so the queries, the org scoping and the demo's redaction are the same code. Its reads name the org (`x-watchlog-service-org`) and carry the in-process mark (`x-watchlog-internal-call`, a secret made at start that never leaves the process); only the worker's own app registers that identity, so the backend serving the API ignores the header. Such a read acts as a viewer of that one org with an API token's read scope (public routes, read methods): no change, no setting, no other org, nothing a member of the org couldn't read. The engine's reads keep `x-watchlog-no-cause`. The worker's app logs no request lines and runs no maintenance (the backend does). Rejected: calling the backend over HTTP (the worker doesn't know its address, and it needs a credential per org: a token at rest to create and rotate); the backend working the cause out on the worker's behalf (a new internal route between two processes, for the same reads).
  - **One source of words:** the headline templates move from `en.json` into a workspace package, `@watchlog/cause-words`, with the formatting of their facts (bytes, cores, durations; the dashboard's byte and second formats come from it too) and a renderer for the part of vue-i18n's format they use (`{fact}` and "singular | plural" by `n`). The web merges the templates into its English messages; the backend renders the line with them. It is plain JavaScript without dependencies, so the backend image copies it and runs it without a build. `web/test/cause-templates.test.ts` renders every headline code both ways (vue-i18n and the package, each plural form) and fails on any difference. `app_finding` (the finding's own sentence, never likely) stays with the web.
  - **The alert's timeline** marks each message that carried the likely cause: `withCause` on the alert detail's notifications (optional), "with the likely cause" ("with what was likely" on the resolve).
  - **Amendments found while reviewing slices 5 and 6:**
    - ADR-154: a dip of one minute or less in the throttled share, with throttled minutes on both sides, doesn't end `cpu_throttled`'s run (on a busy VM one minute's mean fell under 25 % and the cause came out possible);
    - ADR-156: each `possibleCauses` entry carries `where` (`{code, facts, name}`, its chain's last step), and the Needs-attention line shows that step's sentence, named after its object when the sentence doesn't name it, the rule's one-line cause only as a fallback;
    - ADR-146: for a resolved alert, a followed edge's history reaches back to the window's start and counts only up to its end, each run counted back from its newest point that holds before the end; a state step whose start falls after the alert ended has no start rather than a later one (an edge step read "since" the resolve time: the run was the one lasting to now, a later failure);
    - the cause sentences write "98%", without a space.
    - ADR-152: crash_exit on Kubernetes skips a termination with reason `Unknown` (exit 255: the node or the runtime restarted the container; after a reboot every pod has one), and one exit of a pod that runs again and isn't failing is partial, a lead (a node reboot made a scaled-to-0 dependency read as "web keeps exiting with code 255: 1 restart").
    - `flow.failed.ratio` (the failed-connections rule, the edge charts) is capped at 1: the failed and total counters are scraped apart, so a message read "102% of connections failed".
- Consequences:
  - A firing message waits for its cause at most 2 s (measured: 122–492 ms); a resolve, a reminder and the other channels' copies don't wait.
  - The worker's process holds the whole app (its routes and the answer cache), with no measurable difference at idle: about 75 MB resident under tsx, against 80 MB for the worker before this slice (the app is built once, its cache holds answers for 15 s).
  - `alert_states` gains two nullable columns (an additive migration); alerts that fired before have no kept answer, so their resolves carry no line.
  - Telegram has no fake endpoint in the e2e kit (its chat is bound through the connect flow): its message is tested against the unit tests' mock Bot API only.

## ADR-158: The service map fits the desktop, its panel folds its charts, and flow destinations the agent can't name yet

- Date: 2026-11-11 · Status: accepted (v0.4 UI review, before slice 8)
- Context:
  - Selecting an edge opened every chart in the right panel: the page scrolled about 1,100 px at 1440×900 and 1,750 px at 1280×800 (measured on the e2e demos), while the map stayed 640 px tall with empty space under it and under the filters.
  - On the Docker fleet, `demo-control-plane → 10.244.0.0/24:8080` looked like an unresolved pod network. Measured: the source is the kind node's Docker container, and the flows are its kubelet's liveness (8080) and readiness (8181) probes of the two CoreDNS pods at 10.244.0.3 and 10.244.0.5, every 10 s (exactly 120 connections per 10 minutes per port). Those addresses live on the pod network inside the kind node; the Docker agent knows only the host's containers, so they are external to it. The same for `demo-worker → 10.244.2.0/24:8443` (the readiness probes of the two cluster-agents on that node) and `demo-worker2 → 10.244.1.0/24:10254` and `:8443` (the ingress controller at 10.244.1.20: its readiness probe, and its HTTPS port reached through the node).
  - On Kubernetes, the raw series showed real misses of the same kind: right after a VM reboot (09:22 and 12:22) every node agent drew `10.244.x.0/24` (pods), `10.96.0.0/24:443` (the `kubernetes` Service) and `172.18.0.0/24:6443` and `:10250` (nodes) as externals, some of them "failing", for about 35 s. The agent's log said why: the cluster-agent didn't answer yet ("ip map unavailable"), and with no IP map at all every address resolved as external.
  - On Docker, a stopped container leaves the identities with no address, so a client still dialling it drew an external named by its DNS answer (`web → api:9898` beside `web → causes-e2e-api-1`) during the causes e2e's `dependency-down`.
- Decision:
  - **Desktop (1024 px and up): the page doesn't scroll.** The map fills the height left under the header; the filters column, the panel, and the Connections, External and DNS lists scroll inside their own column. 1440 px and up: filters 230 px, panel 340 px; 1280 px: 200 and 320; 1024–1279 px: the filters fold above the map (as on phones) so the map and a 300 px panel sit side by side. Tablets (768–1023) and phones keep the stacked layout, and the content pane scrolls.
  - **The panel: the numbers and the probable cause first, then the charts in collapsible sections.** An edge: health and reason, the numbers (and HTTP's when seen), the probable cause, then HTTP, Connections and Latency sections; the first one open (HTTP when the edge has HTTP, else Connections). A node: its numbers, then "Called by" and "Calls"; the first with something in it open. Each selection starts that way again; a closed section renders nothing, so its charts load only when opened.
  - **Before the first IP map, private destinations are unresolved, not external** (Kubernetes): addresses in 10/8, 172.16/12, 192.168/16, 100.64/10 and fc00::/7 are dropped and counted in `watchlog_agent_flow_cluster_unresolved_connections_total` (with a Service's DNS name they still go to that Service). Public addresses stay externals. Once a map has arrived, an address it doesn't have is an external as before (a database outside the cluster).
  - **An address that leaves the map keeps its owner for an hour,** on both platforms: a deleted pod's or a removed Service's address still resolves to its workload or Service, and a stopped or removed container's address to the container, until something else takes the address or an hour passes. A client still dialling it shows as failing to reach that dependency, not as a new external.
  - **Kind nodes seen by a Docker agent stay externals.** A Docker fleet on a host that runs kind sees each kind node as a container; what its kubelet and pods dial inside it is invisible to Docker. Drawing them as externals is correct; the map may later label private networks as such (not decided here).
- Consequences:
  - The scroll suite gains the map with an edge and a node selected at 1440, 1280 and 390 px; the responsive suite checks the map with an edge and a node selected and every section open, for Kubernetes and Docker.
  - An agent that never reaches its cluster-agent draws no in-cluster destinations at all (they are counted), rather than a map of `/24` externals.
  - The agent change needs the node agents redeployed; the dashboard change doesn't.

## ADR-159: The overview's layout, and Needs-attention lines that add a fact: no restated symptom, host and daemon restarts, one restart count

- Date: 2026-11-11 · Status: accepted (the owner's v0.4 UI review, before slice 8; refines ADR-152, ADR-154, ADR-156)
- Context: the owner's review of the v0.4 overview. Measured on the e2e backend, a few minutes after the demo VM rebooted:
  - **Layout:** the overview's two-column rows stretched each card to the taller one, and the resources chart grows with its card, so at 1440 px it was 1090 px tall (its card 1185 px) beside a Needs attention of 8 items; Top workloads (5 rows) was stretched to Recent changes (8) the same way. A chart drew a straight line across the minutes the VM was down, and the traffic tile read "13% failed · p95 0.5 ms · ▲ 390%", the last part being the traffic's change, wrapped onto two lines at 1280 px.
  - **Restated causes:** a Docker container that exited once read "storefront-orders-1 exited with code 130" with "Likely: storefront-orders-1 exited with code 130." under it (crash_exit's "once" form, ADR-152).
  - **Reboots:** on the Docker host, a clean reboot stopped every container as the host shut down (exit 0, 130, 137, 143), 10–20 s after the agent's last report (08:41:13), and the host booted at 08:50:31; Docker started again only the containers whose restart policy says so (the e2e containers' `no` stayed stopped, `always` ran again). A hard reboot left exit 255 on every container that ran, marked by the daemon 4–6 s after the boot (nginx-e2e, 07:03:37 against a boot at 07:03:31), the same second on all of them. The agent reports each container's state, exit code and finish time (only while stopped), and the host's boot time (`watchlog_node_boot_time_seconds`) with each report; it reports **no restart policy and no daemon start**, and a Docker start at boot adds no restart to the container's count. Stopped containers stayed "exited with code N" problems for a day. On kind every pod got one termination Unknown/255 at the reboot and the node a `Rebooted` event; pods with three restarts or more in their life were then "crash-looping" for 10 minutes (30 of them).
  - **Two counts:** fx-crashloop's title said "29 restarts in 10 min" (the restarts alert, the counter's 10-minute increase) and its cause "546 restarts in the last hour"; the counter rose 126 in that hour (about 3 a minute). `increase()` counted a series' first point as restarts when the object was born inside the range, and its check was the wrong way round: any object created before the range had its whole lifetime counted (405 + 126 + 22). The Kubernetes OOM pod read "280 times in the last hour" against 273 restarts in its life.
  - **The consumer's OOM** read "is OOM-killed because host lima-watchlog-iso runs out of memory: it has no memory limit of its own", cut with an ellipsis; it has a 384 MiB limit, but a stopped container reports no metrics, so the limit read as none.
  - A Docker cause read "keeps exiting with code 143" under "exited with code 1": Docker events are aggregated per container and reason, and the Died event's message held an older exit.
- Decision:
  - **Layout:** below the tiles, the overview is two columns that stack on their own, not rows (rows aligned to the top still made the cards under the chart wait for a tall Needs attention: a 300 px empty gap under the chart). The wide column (2/3) holds Cluster resources, Top workloads or containers, and Warning events; the narrow one Needs attention, Recent changes, and Pods by node or Containers by host; the same on Kubernetes and Docker. On a page narrower than 860 px (about 1100 px of window with the sidebar) it is one column: Needs attention, Cluster resources, then the rest. The resources chart has a fixed height (320 px). Needs attention shows the first 6 problems and "+N more in Alerts"; the problems are ordered worst first (critical, then firing alerts before object problems, then oldest), which also orders `get_problems` and the first 20 that get a cause.
  - **Charts break their line where there is no data:** the query returns no points while an agent is silent, and a line drawn across the gap read as CPU slowly rising while the VM was down. The shared chart puts a null after every gap longer than two of the series' steps (its most common distance between points); a missed scrape or two stays joined.
  - **The traffic tile's sub-line** is the failed share and the connect p95, on one line. The traffic's change against the previous period ("▲ 390%") sat after the failures and read as theirs; it is gone (the sparkline shows the trend).
  - **The line under a problem:** a Likely or Possible chip with the sentence, which wraps and is never cut; "No clear cause" is the chip alone (the panel says what was checked); a problem from the "agent not reporting" rule gets no cause at all (it is already where it starts).
  - **A cause must say something the problem doesn't.** This is the engine's rule, not the line's: crash_exit no longer matches one exit with no restart (a Docker container that exited once and stays stopped, a pod with one exit that isn't failing now), since "exited with code N" is the problem's own fact; the answer is "no clear cause" with its checks. A pod in back-off stays crash_exit. A test replays every Needs-attention problem recorded on kind and Docker (with the ones listed before these fixes) and fails when a likely cause's headline has no fact the problem's title and why-line lack, or a cause is the exit alone.
  - **Stopped with the host:** a stopped container whose stop came with its host's reboot (it finished between a minute before the host's last report before its boot and the boot, or carries the daemon's exit-255 mark within 2 minutes after it) or with its daemon's restart (an exit-255 mark within 10 s of two other stopped containers' on the host, with no reboot) is `stoppedWith: {how: host | docker, at}` in the containers API (additive). It is no problem while it stays stopped: Docker's restart policy decided not to start it again. Its cause is `node_or_host` ("… stopped when host docker-01 restarted at 08:50."; "… when Docker on host … restarted …"), which covers crash_exit. The last report before the boot is one more query per host that booted in the last 25 hours (`tlast_over_time` of the boot-time series, offset to the boot). A daemon restarted cleanly without a reboot (`systemctl restart docker`) leaves nothing that tells it from containers stopped one by one, and isn't recognised; nor is a container its policy started again that then failed by itself (a publisher whose broker didn't come back).
  - **Kubernetes, the same:** a termination with reason Unknown (the node or runtime restarted the container) no longer makes a pod crash-looping (the problem and the "Pod CrashLoopBackOff" alert); back-off still does. node_or_host gains "… restarted when node … restarted at 08:50." for a pod whose newest termination is Unknown within 5 minutes of its node's `Rebooted` event, when the symptom is a restart (no alert, or a crash-loop or unavailable-workload alert): complete with at most that one restart in the hour.
  - **One source and one window:** the counted hour counts a series' first point only for an object created at most 5 minutes before it. crash_exit's headline with an interval gives the exit code and how often ("exits with code 2 about every 24 s."), not a second count beside the problem's own; the count stays in the chain's first step ("146 restarts in the last hour"), from the same restart counter as the alert.
  - **A stopped container's last limit:** the containers API gives a stopped container the last memory limit it ran with in the last day, so a container killed at its own limit is oom_limit's, not the host's; a running container without a limit series has none. On Kubernetes the limit comes from the pod spec and was right.
  - **A stopped container's own exit** (code and time) is its newest; the Died event is read only while it runs again.
  - **Times in cause sentences:** a headline's moment (`at`) reads as the viewer's clock ("08:50") in the dashboard and in UTC in notifications ("08:50 UTC"), like the alert's own facts.
- Consequences:
  - The overview's left and right columns end at different heights; nothing waits for anything.
  - After a reboot, Needs attention lists what is still wrong, not every container and pod the reboot touched. A reboot of a host whose agent didn't report before it is recognised only through the daemon's exit-255 marks.
  - The Docker containers list and the overview make one or two more metric queries per recently booted host; the hosts list only with its heatmap.
  - Recorded answers with crash_exit's "once" form now answer "no clear cause"; MCP's `explain_problem` and the notifications follow the engine (a firing message carries no line for such a problem).

## ADR-160: Container CPU throttling alerts on the share of the time, on Kubernetes and Docker; a keep-alive edge is in use; dated headline times

- Date: 2026-11-11 · Status: accepted (v0.4 review leftovers, before slice 8; amends ADR-072, ADR-146, ADR-153, ADR-157)
- Context:
  - **The throttling rule fired on near-idle pods.** "Container CPU throttling" compared throttled CPU time with used CPU time (ADR-072) and called it "% of its CPU time". On the e2e kind cluster, while the VM was loaded, causes-e2e's web, front and caller fired before any scenario ran: 0.0024 s/s throttled against 0.00055 cores used read "433%"; the overview showed hot at "1577%". The value isn't a share of anything, and a moment of throttling on a container that hardly runs makes it huge. The cause rule (`cpu_throttled`, ADR-154) reads another number: the throttled seconds a second, at most 1, against 25 %. Docker had no throttling alert at all (ADR-124).
  - Measured on the e2e kind cluster and Docker host over 6 and 12 hours (one-minute rates; e2e and demo pods with CPU limits of 20m–300m): idle containers peaked at 0.10–0.30 s/s throttled for a minute under load (Docker front 0.30, caller 0.15; kind caller 0.16, web 0.11), and never held more than 0.05 s/s for 15 minutes; hot's busy loop at its 20m limit held 0.97 (kind) and 1.04–1.25 (Docker, several threads); hog's OOM scenario held 0.21 on Docker.
  - **A live, slower edge read as gone.** The demo kit's busy-backend test (podinfo's api → backend, kind) answered `cpu_throttled` with a first step "api's calls to backend stopped since 09:21:30" although the edge was live and only slower, and the dependency check flickered `dependencies_quiet` even at baseline. Reproduced in a fresh namespace and Compose project (a loadgen → podinfo api → podinfo backend at a 30m CPU limit with a busy loop): api's HTTP client keeps its connections, so the edge's last _new_ connection was 20 minutes old on kind and outside the hour on Docker, while its bytes and requests flowed every second. The walk's edge history and the dependency check counted new connections only; the map itself already treats bytes as use (`idle` is no connection and no bytes).
  - **Headline times had no date:** "restarted at 10:33" read as today for yesterday's restart.
- Decision:
  - **The rule reads the throttled share.** `k8s.container.throttling` keeps its key, name, 25 % and 15 minutes, and now reads `workload.container.cpu.throttled_share`: a workload container's throttled seconds a second, capped at 1, of its most throttled pod (the same quantity as `cpu_throttled`'s share). The words say "throttled 40 % of the time". The threshold is the floor: 25 % is at least 0.25 s throttled every second for 15 minutes, five times what any idle container held, so no extra floor on used CPU is needed (one would also hide a container whose tiny limit is the problem).
  - **Docker gets the same rule,** `docker.container.throttling` ("Docker container CPU throttling", per container, `container.cpu.throttled_share`, 25 % for 15 minutes, warning). `cpu_throttled` treats both alerts as the throttling itself: on its own object the cause is complete.
  - **Stored rules (ADR-107):** a migration sets a stored `k8s.container.throttling` threshold that isn't the shipped 25 % back to 25 %: a value chosen for throttled ÷ used can't be translated into a share. Its switch, channels, severity, duration and history stay. An alert that fired before shows its old value capped at 100 % until it resolves.
  - **The old metric stays** in the catalog (`workload.container.cpu.throttling`, now labelled "throttled per CPU second used") so custom rules made on it keep working and stay editable; the custom-rule editor offers the share first, on both platforms. The API change is additive (two metric keys, one default rule).
  - **Traffic is connections, bytes or requests.** A followed edge's history takes its last traffic from new connections, bytes either way and HTTP requests; the dependency check counts an edge as called when it has new connections, failures, HTTP requests or isn't `idle` on the map. A keep-alive edge that slows reads "slowed from 3 ms to 178 ms", not gone, and isn't quiet. A stopped Docker dependency still reads quiet (no traffic at all, its callers' lookups failing).
  - **A headline moment on another day carries its date:** "restarted at Nov 10, 10:33" in the dashboard (the viewer's day) and "at Nov 10, 10:33 UTC" in notifications (the UTC day); another year adds the year. `@watchlog/cause-words` formats both.
  - **The Docker overview's status strip speaks Docker:** "crash-looping container", "host issue".
- Consequences:
  - A container that runs and meets its limit for a moment no longer pages anyone; one held at its limit does, on both platforms, and its alert's likely cause is `cpu_throttled` on itself.
  - Installs that changed the throttling threshold get 25 % back after the upgrade; the release notes say so.
  - Recordings of a keep-alive client on kind and Docker (`kube-keepalive-throttle`, `docker-keepalive-throttle`) replay in the tests; with the old reading their first step was `edge_gone`.

## ADR-161: Probable cause gets a site feature page; the live demo's slow-backend tie is split in the demo kit

- Date: 2026-11-11 · Status: accepted (the owner's v0.4 UI review; release 0.4.0; amends ADR-150, settles ADR-154's demo consequence)
- Context:
  - ADR-150 cut "a site feature page (a home card and a docs page only)" to keep the date. In the UI review the owner asked for a feature page, and for probable cause to lead the site for the launch.
  - ADR-154's consequence: the live demo's slow-backend scenario rolled out backend with a random delay and a 20m CPU limit with a busy loop at once, so `bad_change` (a slower dependency right after its change) and `cpu_throttled` (throttled before or with the slowdown) were both complete at the far end and tied: both "possible".
  - On a Docker fleet that runs on the same host as a kind cluster, the kind nodes' pod and Service addresses are RFC 1918 externals ("External service"), correctly (ADR-158).
- Decision:
  - **The site gets `/features/probable-cause/`,** with the examples and their chains, Likely / Possible / No clear cause, the twelve rules with their Kubernetes and Docker forms, the message line and MCP; probable cause is the home page's launch headline (a card, the Features menu, the first section of "What you get") and a row in the pricing table. This overrides that one cut of ADR-150; the rest of its cuts stand.
  - **The tie is resolved in the demo kit, not in the rule.** slow-backend rolls out only the delay, once an hour, so `bad_change` is likely. A separate busy-backend slot shrinks the running backend pod's CPU limit in place (no rollout, so no change marker) while a loop keeps a core busy, so `cpu_throttled` is likely. `cpu_throttled` and the ranking (ADR-146, ADR-147, ADR-154) stay as they are: when a change and throttling really happen together, a tie that shows both as possible is the honest answer.
- Open, not built: a "Private network" label in place of "External service" for RFC 1918 destinations on a Docker fleet (ADR-158's last point), for the owner to decide later.
- Consequences: the site's copy follows the 0.4.0 docs at the pinned commit (ADR-114); the live demo shows `bad_change` and `cpu_throttled` each as likely, at different times of the hour.

## ADR-162: v0.5 ships before the launch, with MongoDB, as the launch release

- Date: 2026-11-13 · Status: accepted (owner, 2026-11-13; pre-approved in the v0.5 build brief, reviewed after the fact; amends ADR-141 and the roadmap's order)
- Context:
  - The roadmap put v0.5 (integrations wave 2 and the gaps launch feedback would show) after the big launch, and ADR-141 moved MongoDB to a point release about a week after it (first 0.3.1, then 0.3.2). 0.4.0 shipped on 2026-11-11, so neither number can come next.
  - The launch (Show HN, r/kubernetes, r/selfhosted, CNCF Slack, Product Hunt; Wednesday 2 or Thursday 3 December 2026) has to show a complete product. The gaps a first visitor finds quickest are the services most teams run next to their workloads (MySQL, MongoDB, k3s's Traefik, Kafka), a container's last log lines, and the way around the dashboard.
- Decision:
  - **0.5.0 ships before the launch and is the launch release.** MongoDB moves into it.
  - **Scope, each for Kubernetes and Docker (ADR-124), built in this order:**
    1. MySQL / MariaDB (ADR-163);
    2. MongoDB (ADR-164);
    3. Traefik, with its HTTP stats on the service map (ADR-165);
    4. Kafka (ADR-166);
    5. container logs on demand (ADR-167);
    6. right-sizing hints (ADR-168);
    7. the ⌘K command palette (ADR-169);
    8. a Docker host in the live demo (ADR-170);
    9. the four new services in the demo kit, each with one real failure (ADR-171);
    10. small fixes ride along (the metric rules' alert summaries write "100%" without a space).
  - **Every integration follows the wave-1 pattern completely:** discovery, the three ways to connect a service (ADR-134), encrypted credentials (ADR-133), a catalog in SPEC §4.12, the service page (ADR-135), default rules and rules for every service of the type (ADR-136, ADR-144), structured reasons (ADR-137), an `application_finding` probable cause where one fits (ADR-150), MCP through `list_applications` / `get_application`, the docs page, the site's Applications page and an e2e script.
  - **Out of scope, after the launch, in the order users ask:** MinIO, Elasticsearch (its catalog stays in SPEC §4.12), Google OAuth, the light theme, the Persian locale, and the "Private network" label (ADR-161).
  - **Testing:** fast checks per slice (lint, typecheck, the changed code's unit and Go tests); the full suites (every integration's e2e on kind and a Docker host, causes-e2e, the Helm upgrade test from 0.4.0, the kwok scale test, CI) run once, in the release slice.
- Alternatives: launch on 0.4.0 and ship v0.5 after it (rejected: launch traffic comes once, and the first questions would be "MySQL?" and "logs?"); keep MongoDB as a point release after the launch (rejected: it has no number left, and its catalog has been ready since v0.3).
- Consequences: about 16 sessions of build before the launch (the plan in the maintainer's notes); the 20 November checkpoint can cut from the end of the list (the demo kit's services first, then the palette) without moving the date. Release notes and the site list only what ships.

## ADR-163: MySQL and MariaDB: one integration, read through performance_schema and the status variables

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact)
- Context: MySQL and MariaDB are the most common databases after PostgreSQL in the clusters and Compose files WatchLog sees. They share the protocol, most status variables and the grant model, and differ in performance_schema (on by default in MySQL, off by default in MariaDB), the lock tables, and the replication words.
- Decision:
  - **One type, `mysql`, for both,** named by what the server reports (`version_comment`): "MySQL 8.4" or "MariaDB 11.4". Versions: MySQL 8.0+ and MariaDB 10.6+ (tested on MySQL 8.4 LTS and MariaDB 11.4 LTS). Percona Server reads as MySQL.
  - **Driver:** `github.com/go-sql-driver/mysql` (pure Go, no cgo). One connection per instance, with read-only session settings: `SET SESSION TRANSACTION READ ONLY`, `lock_wait_timeout=5`, and a 5 s statement limit (`max_execution_time=5000` on MySQL, `max_statement_time=5` on MariaDB).
  - **What is read, never table data:** `SHOW GLOBAL STATUS`, `SHOW GLOBAL VARIABLES` (an allow-list), `performance_schema.events_statements_summary_by_digest` (the server's own normalised `DIGEST_TEXT`, so ADR-138 holds), `events_statements_histogram_global` (MySQL 8.0.19+), the process list through `performance_schema.threads` / `information_schema.PROCESSLIST` (client host, user, command, time; the statement text only as its digest), lock waits (`performance_schema.data_lock_waits` on MySQL, `information_schema.INNODB_LOCK_WAITS` on MariaDB, both with `INNODB_TRX`), `SHOW REPLICA STATUS` (MariaDB 10.5.1+ and MySQL 8.0.22+; the older word otherwise), and table sizes from `mysql.innodb_table_stats` (estimates; `information_schema.TABLES` would need privileges on the tables themselves).
  - **The generated user** (ADR-134): `CREATE USER 'watchlog'@'%' IDENTIFIED BY '…' WITH MAX_USER_CONNECTIONS 2; GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'watchlog'@'%'; GRANT SELECT ON performance_schema.* TO 'watchlog'@'%'; GRANT SELECT ON mysql.innodb_table_stats TO 'watchlog'@'%';`. An existing user's grants are checked with `SHOW GRANTS` and each missing privilege names the panels it costs.
  - **MariaDB without performance_schema** (its default): statements, the histogram and MySQL's lock tables are unavailable; the page says so with the one line to turn it on (`performance_schema=ON`, needs a restart), and the reason `performance_schema_off` is a hint, not a problem. Lock waits still work through `INNODB_LOCK_WAITS`.
  - **Discovery:** images `mysql`, `mariadb`, `percona`, `bitnami/mysql`, `bitnami/mariadb`, the Oracle MySQL operator's and the MariaDB operator's; port 3306.
  - **Probable cause:** `lock_waits` (the blocking session's client workload or container through the IP map, how long, since when) and `connections_near_max` (the clients holding most) are `application_finding` causes, like PostgreSQL's; the chain ends at the holder's own cause when it has one (a CronJob that started, a rollout).
  - **Dependency and image budget:** the integrations image must stay within its budget. ADR-057: "Both images FROM scratch (ADR-020), amd64 and arm64, each ≤ 40 MB; CI reports sizes"; ADR-131 holds the integrations image to the same ≤ 40 MB (compressed), ≤ 128 MB RSS and ≤ 5 % of a core with every integration on one instance each. Today it is 14.9 MB with pgx. Slice 1 measures the image with the driver added and records the number here; over budget, the smallest working option wins and gets its own ADR.
- Alternatives: `mysqld_exporter` (rejected: one more image to wire per service, no connect flow or reasons); reading the slow log (rejected: a file or a table that must be switched on; the digest summary gives mean and max per statement); `information_schema.TABLES` for sizes (rejected: needs privileges on the tables).
- Consequences: catalog in SPEC §4.12. Galera and group replication are read as single servers with their own status (wsrep and group state are flagged, not interpreted). Statement text kept is the server's digest text, already free of literals.
- Measured in slice 1 (2026-11-13), on MySQL 8.4.13 and MariaDB 11.4.13 on the e2e VM:
  - **Image budget:** the driver (`go-sql-driver/mysql` v1.10.1, with `filippo.io/edwards25519` for MariaDB's ed25519 login) adds 0.60 MB to the integrations binary on amd64 (11.43 → 12.03 MB stripped; 4.15 → 4.40 MB gzipped) and 0.52 MB on arm64 (10.75 → 11.27 MB; 3.73 → 3.96 MB gzipped): far inside ADR-057's 40 MB.
  - **The generated user's command** is one form for both servers: `sh -c` picks the client the image has (MariaDB 11 ships no `mysql`), `-p` asks for root's password at the prompt (`exec -it`), and `GRANT PROCESS, REPLICATION CLIENT /*M!100509 , SLAVE MONITOR */` adds, on MariaDB only, the privilege its `SHOW REPLICA STATUS` needs (MariaDB maps `REPLICATION CLIENT` to `BINLOG MONITOR` alone). The SQL uses backticks and double quotes so it fits one single-quoted argument.
  - **PROCESS is the one required privilege** (the probe fails without it, naming it); the others cost panels, which the probe lists in its facts and the page marks per panel.
  - **Lock waits** pair `INNODB_TRX` rows through `data_lock_waits` (MySQL) or `INNODB_LOCK_WAITS` (MariaDB) with the table from `data_locks` / `INNODB_LOCKS`, never their `LOCK_DATA` (the locked row's key). The reason `lock_waits` carries the holder (`holder`: its workload or container through the IP map), the table, the wait and how long the holder's transaction has been open; probable cause follows it (`app_lock_held`).
  - **Statements** are grouped by digest (the same statement in two schemas is one row); WatchLog's own reads (`SHOW`, `SET`, `SELECT @@…`, `performance_schema`, `information_schema`) are left out. MySQL's histogram (450 buckets in picoseconds) is summed into WatchLog's six buckets in the collector.

## ADR-164: MongoDB: built from the v0.3 catalog with the official driver v2

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact; MongoDB's version per ADR-162)
- Context: SPEC §4.12 has had MongoDB's catalog since v0.3; ADR-141 moved the build out of v0.3. ADR-162 brings it into 0.5.0.
- Decision:
  - **Driver:** the official `go.mongodb.org/mongo-driver/v2`. One client per instance with a direct connection to each member (`directConnection=true`), so each member reports for itself; read preference `nearest`, 5 s per command.
  - **Versions:** MongoDB 6.0+ (tested on 7.0 and 8.0), standalone and replica sets. A `mongos` is read as a member (serverStatus only); per-shard discovery behind it isn't built.
  - **Commands, all within `clusterMonitor`:** `serverStatus` (with `opLatencies` histograms), `replSetGetStatus`, `getLog global` (the "Slow query" entries), `top`, `listDatabases`, `dbStats` (50 databases), `$collStats` storage stats (100 collections, by size, on the heavy scrape), `$indexStats` (indexes never used), `$currentOp` with idle connections (clients by address). An optional `read` on `local` adds the oplog window.
  - **Query text (ADR-138):** a slow entry's filter is kept as its shape: field names and operators, every literal replaced by `?`; MongoDB 8.0's `queryShapeHash` is the fingerprint when present.
  - **Clients:** `$currentOp`'s client addresses and a slow entry's `remote` go through the IP map to workloads or containers. That gives "connections by workload", and lets `slow_collscan` name who sends the scans.
  - **Probable cause:** `slow_collscan` (the client workload, the collection, since when) and `connections_near_max` are `application_finding` causes; `no_primary` and `member_down` chain to the member's pod or container (its OOM, crash or node).
  - **Discovery:** images `mongo`, `mongodb/mongodb-community-server`, `bitnami/mongodb`, Percona's and the MongoDB community operator's; port 27017.
  - **Image budget:** as ADR-163 (ADR-057's ≤ 40 MB, ADR-131's limits). The driver is the largest of the three new dependencies; slice 2 measures it and records the number here.
- Alternatives: `mongodb_exporter` (rejected, as for MySQL); the v1 driver (rejected: in maintenance; v2 is the supported line).
- Consequences: SPEC §4.12's version line becomes v0.5.0, the catalog stays with the corrections slice 0 made (the client addresses, the shape rule, the version range).
- Measured in slice 2 (2026-11-13), on MongoDB 7.0.48 (Docker) and 8.0.38 (kind), each a replica set with authentication on:
  - **Image budget:** the driver (`go.mongodb.org/mongo-driver/v2` v2.10.0, with `xdg-go/scram`, `xdg-go/stringprep`, `youmark/pkcs8`, `golang.org/x/crypto`, `golang.org/x/sync`) adds 2.74 MB to the integrations binary on amd64 (12.03 → 14.76 MB stripped; 4.40 → 5.40 MB gzipped) and 2.49 MB on arm64 (11.27 → 13.76 MB; 3.96 → 4.84 MB gzipped): inside ADR-057's 40 MB.
  - **Privileges:** a user with `clusterMonitor` alone ran every read: `serverStatus`, `replSetGetStatus`, `getLog`, `top`, `listDatabases`, `dbStats`, `$collStats`, `$indexStats`, `$currentOp` with idle connections, **and `find` on `local.oplog.rs`** (`rolesInfo` shows `clusterMonitor` with `find` on the whole `local` database on both versions). So the optional `read` on `local` is dropped: the generated user gets `clusterMonitor` only. `listCollections` on an application database needs `authorizedCollections: true` (refused without it).
  - **Shapes measured:** 7.0 has no `queues.execution` (tickets are in `wiredTiger.concurrentTransactions`), 8.0 has both; `opLatencies` histograms are `{micros, count}` pairs (int64); `mem.resident` is in MB; a write logs twice ("WRITE" `type: update` on the collection with `{q, u}`, and "COMMAND" on `db.$cmd`), so `$cmd` lines are left out; a `getMore` carries its `originatingCommand`; 8.0 adds `queryShapeHash`; lines with no `remote` are the server's own work and left out. A member's name in `replSetGetStatus` is its host (`mongo-0.mongo.<ns>.svc.cluster.local:27017`, `<project>-mongo-1:27017`), cut to the pod or container name.
  - **The oplog window** is only the set's age until the oplog fills, so the collector also sends the oplog's size and `maxSize`, and the default rule waits for 90 % full.
  - **Clients:** `$currentOp`'s `client` addresses mapped through the IP map named the e2e `analytics` client on both platforms (`mongodb-e2e/analytics`, `mongodb-e2e-analytics-1`); so did the slow lines' `remote`.

## ADR-165: Traefik: its Prometheus metrics, and what they add to the eBPF HTTP stats on the map

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact)
- Context: Traefik is k3s's default ingress and a common Compose proxy. Since v0.3 the service map shows HTTP stats from eBPF on plain HTTP/1.x edges (ADR-139), so a Traefik pod's edges already carry requests, errors and latency when traffic is plain HTTP. What eBPF can't see: requests that arrive over TLS (Traefik terminates it), backends reached over TLS or HTTP/2, and requests Traefik answers itself without ever connecting to a backend (502, 503, 504 when no server is up or none answers in time).
- Decision:
  - **Source:** Traefik's own Prometheus metrics, read with promtext from its `metrics` entrypoint (`:9100/metrics` in the Helm chart and in k3s's bundled Traefik; `:8080/metrics` with the default `traefik` entrypoint). Versions: v2.10+ and v3. Without metrics, requests, errors and latency come from eBPF as for plain Nginx, and the reason `metrics_off` gives the setting (k3s: a `HelmChartConfig`; Helm: `--set metrics.prometheus.entryPoint=metrics`; Docker: the three flags).
  - **Series as they are,** with fewer labels: entrypoint and service families keep `entrypoint`, `service`, `code` (method and protocol summed away); router families only when Traefik exports them (`addRoutersLabels`, off by default); `traefik_service_server_up{service,url}`; `traefik_tls_certs_not_after`; config reloads. A service label is mapped to its backend: on Kubernetes `<namespace>-<service>-<port>@kubernetes` (and `@kubernetescrd`) is the Service; on Docker `<name>@docker` is the container or Compose service; a server URL's address goes through the IP map to a pod or container. At most 4,000 series per member.
  - **On the service map:**
    - eBPF stays the source of an edge's HTTP stats where it has them (ADR-139). Traefik's numbers fill an edge from Traefik to a backend only where eBPF has none (TLS or HTTP/2 to the backend), with the source shown ("from Traefik").
    - Requests Traefik answered itself, with no connection made, are shown on the Traefik → service edge as their own figure: "12/s answered by Traefik: no server up". eBPF can't see them, and they are exactly the outage case.
    - The Traefik node shows requests per entrypoint, TLS included, which no edge carries when clients come from outside the cluster.
  - **Probable cause:** `no_server_up` (a service with every server down) chains to the backend workload or container's own cause (scaled to 0, crashing, OOM), through `application_finding`; `errors_high` names the top service and its workload's last rollout, as Nginx's does (ADR-143).
  - **Discovery:** images `traefik`, `rancher/mirrored-library-traefik` (k3s); ports 80, 443, 8080, 9100; on Docker the official image.
- Alternatives: Traefik's API (`/api/rawdata`) for routers and services (rejected: often off, and the dashboard API exposes the configuration); counting eBPF only (rejected: misses TLS and the requests that never reach a backend).
- Consequences: catalog in SPEC §4.12. Paths and hosts are never collected (ADR-139). A Traefik without metrics still gets a page from eBPF.
- Measured in slice 3 (2026-11-13), on Traefik 3.6.25 (kind, Ingress and IngressRoute; Docker 29 with the Docker provider) and 2.11.62:
  - **Requests Traefik answers itself** ("no available server", 503, when a service has no server up) are counted on `traefik_entrypoint_requests_total` and **never** on `traefik_service_requests_total`. So "answered by Traefik" is the entrypoints' 503s minus the services' 503s, and the service with no server up is found from its backend: the Service's ready endpoints (Kubernetes), the container's state (Docker), or `traefik_service_server_up`, which exists **only for services with a health check**.
  - **Without `allowEmptyServices`** (Traefik's own default; the Helm chart turns it on) an Ingress whose Service has no endpoint is dropped from the configuration, and its requests get a 404 from no router. On Docker, a stopped container's route is removed the same way. Both show as the backend's own state, not as no server up.
  - **Service names:** `<namespace>-<service>-<port>@kubernetes` as decided; an IngressRoute's is `<namespace>-<route>-<hash>@kubernetescrd` (a 20-hex hash, not the Service), so it maps to the route only; Compose's default is `<service>-<project>@docker`, a label's name `<name>@docker`. Namespaces and Services contain dashes, so the split is decided against the cluster-agent's objects.
  - **v2 and v3 differ:** v2's `traefik_entrypoint_open_connections{method,protocol}` became `traefik_open_connections{protocol}` (the collector writes both as the latter); v3 has no `traefik_config_reloads_failure_total` or `traefik_config_last_reload_failure`, so the failed-reload rule works on v2 only. The version comes from `/api/version` when the API answers (no metric carries it).
  - **Docker 29** refuses Traefik before 3.6.1 (its Docker client speaks API 1.24): such a Traefik routes nothing. The docs say so.
  - **Image:** the collector adds 0.07 MB to the integrations binary on arm64 (13.76 → 13.83 MB stripped; 4.84 → 4.86 MB gzipped) and 0.04 MB on amd64 (14.76 → 14.80 MB).

## ADR-166: Kafka: the admin API through franz-go, no JMX, and the consumer group that lost its members

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact)
- Context: small teams running Kafka want to know four things: are the brokers up, are partitions offline or under-replicated, how far behind each consumer group is per topic, and whether a group stopped consuming. The usual way, JMX through an exporter, means a Java agent in the broker, which they rarely set up.
- Decision:
  - **Read through the Kafka protocol only,** read-only, with `github.com/twmb/franz-go` (`kgo`, `kadm`): Metadata (brokers, the controller, partitions, leaders, ISR), ListOffsets (end offsets), ListGroups, DescribeGroups (state, members with client id and client host, assignments), OffsetFetch (committed offsets), DescribeLogDirs (size per topic and broker), DescribeConfigs (retention, when allowed), DescribeQuorum (KRaft, when allowed). No admin call that changes anything is in the code.
  - **No JMX.** What only JMX has (bytes in and out, request latency, handler idle, ISR shrinks) is flagged in the catalog. **If a Prometheus endpoint exists** (the JMX exporter, Strimzi's, Bitnami's), the user names it and promtext reads it into a "Broker internals" tab; nothing else depends on it.
  - **Rates from offsets:** messages in per topic are end-offset growth per second, labelled "offsets/s" (transaction markers and compaction make it approximate); consumption per group is committed-offset growth. Lag is end offset − committed offset per partition, summed per group and topic; lag in time is lag ÷ the topic's in-rate, labelled "about".
  - **Access:** nothing on PLAINTEXT listeners; otherwise SASL (PLAIN, SCRAM-SHA-256/512) over TLS or not, through the three ways to connect (ADR-134). With ACLs: `Describe` on the cluster, every topic and every group (`DescribeConfigs` optional); a missing one names what it costs. Versions: Kafka 3.0+ with ZooKeeper or KRaft, 4.x KRaft.
  - **Caps (ADR-136):** 200 topics (by size), 100 groups (lagging first), partitions summed per topic; per-partition rows only in the status's extra for offline and under-replicated partitions (top 50).
  - **The lost group:** a group with committed offsets whose state is `Empty` (no members) while its lag grew for 5 minutes, having had members in the last 24 hours. The collector remembers each group's last members (client id, client host); the backend maps their addresses through the IP map. The reason `group_no_members` links them, closest first to the moment the group emptied, as RabbitMQ's `queue_no_consumers` links its consumers (ADR-145); when the addresses are gone from the IP map, the eBPF flows into the broker port over the last 24 hours stand in. In probable cause it is an `application_finding` that chains to the member's own cause (OOM-killed, crashing, scaled to 0).
  - **Discovery:** images `apache/kafka`, `apache/kafka-native`, `bitnami/kafka`, `confluentinc/cp-kafka`, Strimzi's; port 9092. Every broker is a member; the collector bootstraps from the one discovered and reads the rest from Metadata.
  - **Image budget:** as ADR-163 (ADR-057's ≤ 40 MB, ADR-131's limits); slice 4 measures franz-go's cost and records it here.
- Alternatives: JMX through Jolokia or an exporter (rejected: a Java agent in the broker, the setup small teams skip); `sarama` (rejected: larger, and kadm's admin calls are what is needed); Kafka's Connect/REST proxy (rejected: an extra component).
- Consequences: catalog in SPEC §4.12. Redpanda speaks the protocol and may work, but isn't claimed. ZooKeeper's own health is not read.
- Measured in slice 4 (2026-11-13), on `apache/kafka-native` 4.1.1 (one KRaft node, PLAINTEXT) on kind (a StatefulSet advertising its pod's DNS name) and in Compose on the VM's Docker (advertising `kafka:9092`), with a producer and an `audit` consumer group:
  - **Image budget:** franz-go (`franz-go` v1.22.2, `kadm` v1.19.0, `kmsg` v1.15.0, with `pierrec/lz4`) adds 3.89 MB to the integrations binary on amd64 (14.80 → 18.69 MB stripped; 5.42 → 6.83 MB gzipped) and 3.54 MB on arm64 (13.83 → 17.37 MB; 4.86 → 6.11 MB gzipped): inside ADR-057's 40 MB. `kmsg` (every message type) is most of it. The versions are the ones a month old, not the newest (released four days before).
  - **Advertised listeners:** Metadata answers on the address the collector dials, but every other request (ListOffsets, the groups, DescribeLogDirs, DescribeConfigs) goes to the broker's advertised address. In Compose that is `kafka:9092`, which the host-network collector can't resolve, so every request but Metadata failed. **The collector dials the discovered member instead** when the advertised host is loopback or doesn't resolve within a second: the member named by the host's first label (a StatefulSet pod's DNS name), else the only member. On kind the pod's DNS name resolves from the collector's pod and is used as is.
  - **Group members:** `DescribeGroups` gives each member's client host as `/172.24.0.4` (a leading slash, cut by the collector); mapped through the IP map it named `kafka-e2e-audit-1` on Docker.
  - **The lost group:** when the only consumer is killed, the group stays `Stable` with the dead member for the session timeout (about 45 s), then turns `Empty` with no members while its lag keeps growing; kadm's lag still counts it from the committed offsets. So the collector remembers each group's members and, once it is empty, sends them with the first scrape that saw it empty (`last_members`, kept for 24 hours).
  - **Access:** with no ACLs, every read answered, `DescribeQuorum` included (leader 1, one voter). Without TLS on the listener nothing else is tried. SASL mechanisms are not chosen by the user: the client offers SCRAM-SHA-512, SCRAM-SHA-256 and PLAIN and the broker's first supported one is used; a listener that closes a plaintext connection is tried again with TLS, unverified, as MongoDB's and PostgreSQL's `prefer` (no private CA can be given yet).
  - **The version** isn't in the protocol: it is franz-go's guess from the ApiVersions answer ("v4.1" → 4.1; "at least v4.1" → 4.1+); discovery still has the image's tag (4.1.1).
  - **The Prometheus endpoint** isn't named by the user, as the decision says: the collector looks for one on the JMX exporter's usual ports (9404 Strimzi, 5556 Bitnami, 7071) at `/metrics` every 10 minutes, so no setting is needed. Its parsing was tested on Strimzi's names only; the e2e images carry no exporter, so it wasn't measured on a live broker.
  - **Unit tests:** franz-go's fake cluster `kfake` is a separate Go module, which would be a dependency beyond those allowed. The collector reads Kafka through a small `Admin` interface (kadm's calls), and the tests give it the answers recorded on the e2e VM.
  - **Memory:** `apache/kafka-native` 4.1.1 used 226 MiB under a 384 MiB limit with a 20 messages/s producer and one group (ADR-171's question for the demo kit).

## ADR-167: Container logs on demand: the last lines, streamed, never stored

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact; amends SPEC §4.3 and §6.6's P1 line)
- Context: when a pod crash-loops, its last lines are usually the answer, and today people leave WatchLog for `kubectl logs` or `docker logs`. SPEC §2.5 keeps log management a non-goal (no search, indexing, storage or retention), and allows the last N lines on demand. The backend never connects into a cluster (SPEC §5.2), so the request has to reach an agent that is already connected out.
- Decision:
  - **What:** the last N lines of one container, read when someone asks, streamed through the backend to the asker, never written anywhere. Optionally followed live for at most 5 minutes while the panel stays open. No search, no filter, no history, no download of more than what was shown.
  - **Lines:** 200 by default; 100, 200, 500 or 1,000 in the UI (the API takes 1–1,000). Each line is cut at 2 KB, control characters and ANSI escapes stripped (ADR-129). At most 512 KB per answer; the oldest lines go first when it is over, and the answer says so.
  - **Redaction, as ADR-047:** each line passes through `agent/internal/redact` **in the agent**, before it leaves the cluster or host. Redaction is pattern-based; the answer always says that lines were redacted (and how many).
  - **Kubernetes:** the cluster-agent reads `GET /api/v1/namespaces/{ns}/pods/{pod}/log` (`container`, `tailLines`, `timestamps`, `previous` for the container's last run, `follow`) through the API server, which asks the kubelet. Its ClusterRole gains `get` on `pods/log`, nothing else; no `nodes/proxy` (ADR-049) and no host paths. Kubernetes merges stdout and stderr, so lines carry no stream there.
  - **Docker:** the host's agent reads `GET /containers/{id}/logs?stdout=1&stderr=1&timestamps=1&tail=N` (and `follow=1`), added to the allow-list of ADR-024 (a test asserts nothing else is). Lines carry their stream. An exited container's logs are readable while Docker keeps it. Only the `json-file`, `local` and `journald` drivers answer; others say so.
  - **The path:** the backend registers a request in memory; the cluster-agent's leader or the host's agent long-polls `GET /ingest/v1/logs/requests?wait=25` (answered at once when a request arrives) and posts the lines in chunks to `POST /ingest/v1/logs/{requestId}`, which the backend relays to the waiting HTTP response (JSON) or event stream (SSE, for follow). Nothing goes through the agent's disk buffer. A request no agent picks up in 10 s answers 504 with what to check (an agent older than 0.5.0, logs turned off). One backend process holds the request; several replicas (Cloud, Phase 5) need a relay and decide it then.
  - **Never stored:** not in PostgreSQL, VictoriaMetrics, the agent's buffer, request logs or the MCP call log (which already never keeps outputs). The browser holds the lines in memory; "Copy" copies what is shown.
  - **Who may read:** every signed-in role, **Viewers included.** ADR-140 gives Viewers every page, alert and query text; the teammate on call is often a Viewer, and logs are read-only. Two guards instead: an installation switch, `logs.enabled` in both charts and `WATCHLOG_LOGS` on the Docker agent, **default on** (read nil-safe, ADR-107: an upgrade turns it on and the release notes say so; off removes the `pods/log` grant and the agent refuses), and a server setting, "Container logs: every role / Owners and Admins only / off", which Owners and Admins change in Settings. Every read is recorded in `audit_events` (who, which container, how many lines, follow or not), never the lines. Tokens and MCP act with their user's role (ADR-140).
  - **Limits:** 30 reads a minute and 3 open follows per user; 50 open follows per installation. Demo mode allows the demo's own application namespaces and its Docker host's containers, never system namespaces (ADR-111) or WatchLog's own pods.
  - **Where:** a "Logs" tab on the pod page (with a container picker and "previous run") and on the Docker container page; a link from a crash loop's probable cause ("see the last lines"). The REST routes are public reads (ADR-126); the MCP tool `get_container_logs` returns at most 200 lines within ADR-128's 16 KB, newest last, with `truncated`, and its description says the lines are cluster-controlled data (ADR-129).
- Alternatives: the node agent reading `/var/log/pods` (rejected: a host path on every node, rotation and CRI formats to parse, and the node agent would hold log access on every node); the kubelet through `nodes/proxy` (rejected by ADR-049); storing a short window (rejected: that is log management, SPEC §2.5); Viewers refused (rejected: it pushes on-call teammates to shared Admin accounts; the setting covers installations that want it).
- Consequences: the cluster-agent and the Docker agent gain one long-poll each; the agent images grow by a few kilobytes. `docs/security.md` and the chart's RBAC docs list `pods/log`. The e2e asserts that the backend's database and VictoriaMetrics hold nothing of a read's lines.
- Amended 2026-11-13, as built (v0.5 slice 5), measured on kind 1.35 and Docker 29:
  - **Measured:** `pods/log` with `timestamps=true` gives `<RFC 3339 nano> <text>` lines, stdout and stderr merged (and not always in time order); a container without a previous run answers 400 `previous terminated container "main" in pod "printer" not found`, an unknown container 400 `container nope is not valid for pod …`, and a missing previous log can come back as a 200 with one line `unable to retrieve container logs for containerd://…`. Docker's logs endpoint multiplexes with 8-byte frame headers (raw for a TTY); an exited container's log stays readable. A JSON line `{"password":"hunter2"}` was **not** redacted by ADR-047's patterns, which only knew `key=value`: `agent/internal/redact` now also redacts `"key": "value"` and `key: value` fields. 1,000 real lines (a printer with multi-byte text, a 3,000-character line, ANSI colours) came back in 18 ms (kind) and 69 ms (Docker), 83 KB, the long lines cut at 2,048 bytes on a UTF-8 boundary.
  - **Where:** the pod and container pages have no tabs, so "Logs" is a section at the bottom of each, read only when asked ("Show last lines"). Follow is hidden while "previous run" is on. The link from a crash loop's probable cause is not built yet.
  - **Answers:** 403 `logs_off` / `logs_admins_only`, 409 `logs_disabled` (from the agent's heartbeat capability `logs: off`, or the API server refusing `pods/log`), 422 with the agent's code (`container_not_found`, `no_previous_run`, `driver_unsupported`, `read_failed`), 429, 504 `no_agent`. A read refused by the switch or a limit is not audited; one that reaches the agent is, also when the agent then fails. The audit rows stay off the Users page's "Recent changes", which lists user changes.
  - **The relay's limits:** the logs ingest routes count against the cluster's ingest ceiling only, not the agent's own 1-a-second budget, so a follow (one post a second, an empty keep-alive every 15 s that learns 410) never delays metrics. The browser keeps at most 1,000 followed lines. MCP lines are cleaned and capped at 512 characters each; 200 real lines fit as 162 in 16 KB.
  - **Size:** the agent binaries grow by 48–131 KB (watchlog-agent amd64 9.43 → 9.47 MB, cluster-agent amd64 31.42 → 31.48 MB), not a few kilobytes.

## ADR-168: Right-sizing hints: requests and limits against seven days of use, in plain sentences

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact; SPEC §4.3's P1 line comes into Community, ADR-151's principle)
- Context: WatchLog already has each container's CPU and memory use (15 s), its throttling, its OOM kills, and its requests and limits on the objects (ADR-056). Teams over-request because they don't know what their pods use, and under-limit until the OOM killer tells them.
- Decision:
  - **Window:** the last 7 days, at 5-minute resolution. A container with less than 24 hours of data gets "not enough history yet (N of 24 hours)". With shorter retention (Cloud Free) the window is what exists and the sentence says so. Jobs and CronJobs are left out (short runs); system namespaces only when asked (ADR-111).
  - **What is judged, per workload container on Kubernetes** (its pods' quantiles, the busiest pod counting):
    - CPU request too high: request ≥ 2 × the p95 of use and at least 100m spare;
    - CPU request too low: p95 of use above the request;
    - memory request too high: request ≥ 2 × the highest working set and at least 128 MiB spare;
    - memory request too low: p95 of the working set above the request (first to be evicted under node pressure);
    - memory limit tight: the highest working set ≥ 90 % of the limit, or an OOM kill in the window;
    - CPU limit holds it back: throttled ≥ 10 % of the time at p95 (the share of ADR-160);
    - no request or no memory limit set: one sentence with what it used.
  - **Docker** has limits and reservations but no requests, and a limit above use reserves nothing. So a Docker container gets: memory limit tight (as above), CPU limit holds it back, a memory reservation too high or too low when one is set, and no memory limit while it used more than a quarter of the host's memory.
  - **Plain sentences, no scores:** codes and facts rendered through i18n, like reasons (ADR-137): "web asks for 500m CPU; its busiest pod used at most 60m (p95) over 7 days. About 80m would cover it." The suggestion rounds up: CPU p95 × 1.25 to 10m, memory peak × 1.25 to 16 MiB. Each hint says what it is based on. No savings in money, no percentages of "efficiency".
  - **Where:** a "Right-sizing" card on the workload page and on the Docker container and Compose service pages; on the overview, a card with the count and the first three hints (OOM risk first, then the most CPU or memory to give back); `GET /clusters/{id}/right-sizing` (public, filters by namespace, workload, host, container); MCP `get_right_sizing`. Hints are not alerts.
  - **Cost:** worked out by the backend per cluster on request from VictoriaMetrics (`quantile_over_time` and `max_over_time` over 5-minute subqueries) and kept for an hour. Slice 6 measures the query time on the e2e stack and the kwok scale run measures it at 15,000 pods in the release slice; over 5 s there, the hour's answer is computed in the background instead.
- Alternatives: the Vertical Pod Autoscaler's recommender (rejected: a component to install, Kubernetes only); a score per workload (rejected: the owner's "no scores" rule, ADR-147); a 30-day window (rejected: beyond Community's default 15-day retention).
- Consequences: SPEC §4.3 describes the hints; Phase 6's "right-sizing" line is done in Community. No new collection.
- As built (v0.5 slice 6, 2026-11-13; measured on the e2e kind cluster and Docker host):
  - **One new metric after all:** Docker's memory reservation isn't in the cgroup readings, so the Docker agent sends `watchlog_container_memory_reservation_bytes` from inspect when one is set (0.5.0 agents; older agents simply give no reservation hint).
  - **Codes:** `memory_limit_oom`, `memory_limit_tight`, `cpu_limit_throttled`, `memory_request_low`, `cpu_request_low`, `memory_reservation_low`, `cpu_request_high`, `memory_request_high`, `memory_reservation_high`, `cpu_no_request`, `memory_no_request`, `memory_no_limit`; one per resource in the API, and the dashboard says a container's "not set" ones in one sentence (ADR-168's "one sentence").
  - **A request left out while a limit is set is the limit** (Kubernetes's default), so a pod with only limits isn't "not set".
  - **OOM kills on Kubernetes** come from the pods' last terminations in the window (one per pod at most: a lower bound); on Docker from the OOM counter's increase.
  - **Give back** counts every running replica; the overview orders give-back hints by CPU and memory on one scale (1 core ≈ 4 GiB). A workload scaled to zero gets no hints.
  - **Cost:** the use is kept an hour per cluster; requests and limits are read on every request, so a changed request shows at once. Six queries (Kubernetes) or twelve (Docker), run together: **53 ms** for the kind cluster's 65 workload containers and **31 ms** for the Docker host's 23 containers, with about 20 hours of history in the window. Far from 5 s, so no background computation; the kwok run in slice 10 measures 15,000 pods.
  - `WATCHLOG_RIGHT_SIZING_WINDOW_HOURS` (168) and `WATCHLOG_RIGHT_SIZING_MIN_HOURS` (24) shorten the window and the history needed, for tests.
  - Not built: a link from a hint to the workload's own Likely cause panel (the hint links to the probable-cause docs instead; the panel is on the same page).

## ADR-169: The ⌘K command palette

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact; SPEC §11.3's P1 search)
- Decision:
  - **Opens with** ⌘K on macOS and Ctrl+K elsewhere, `/` when focus isn't in a field, and a search button in the top bar (a 44 px icon button on phones, where the palette fills the screen).
  - **Finds:** pages (the navigation's own list, matched in the browser), clusters and Docker fleets (from the store; picking one switches), and the selected cluster's objects through `GET /clusters/{id}/search?q=&limit=`: on Kubernetes workloads, pods, nodes; on Docker hosts, containers and Compose projects; on both, applications. Names in PostgreSQL, case-insensitive, prefix matches before substring matches, at most 8 per kind and 40 in all, 150 ms after the last key. Each result shows its kind and its namespace, host or type. The five last picks (this browser only) show before typing.
  - **Keyboard-first and accessible:** a modal dialog with an ARIA combobox and a grouped listbox (Reka UI's Dialog and Combobox, already used per ADR-092; no new dependency): ↑ ↓ to move, Enter to open, Esc to close and return focus where it was, the count announced in a live region, design tokens only, visible focus, every string in i18n.
  - Read-only navigation: no actions that change anything. Works in demo mode.
- Alternatives: loading every object into the browser (rejected: 15,000 pods); a palette library (rejected: no new dependency for a dialog and a list Reka UI already gives).
- Consequences: the route is a public read (ADR-126), so API users get name search too; the responsive suite covers the palette at 360–1440 px.
- As built (v0.5 slice 7, 2026-11-13; measured on the e2e kind cluster and Docker host, and on a synthetic 15,000-pod cluster in the e2e PostgreSQL):
  - **Matching is fuzzier than "prefix, then substring",** because pod names are long and hashed: a word matches when its letters appear in order in `namespace/name` (`pay7d9` finds `payments-api-7d9f…`), and words of 4 to 32 letters also with one letter off (a wrong, extra or swapped letter). All of it is LIKE patterns in PostgreSQL (no `pg_trgm`, no migration). The order: exact name, prefix, substring, in the namespace and name, letters in the name, letters in the namespace and name, one typo; shorter names first. A space also stands for `-` ("payments api"). **One-typo matches show only when nothing matches better**, otherwise `node-42` listed `notify-web-429`. Applications also match by type ("redis" lists every Redis).
  - **Groups are ordered by their best match**, not fixed: an exact node comes before pods that only match by letters. Equal ranks keep a fixed order (pages, clusters, workloads, pods, nodes, hosts, containers, Compose projects, applications). The answer has `kind`, `name`, `namespace`, `host`, `type`, `id` and `match` (the tier), and `truncated`.
  - **Measured:** the list routes the palette would otherwise need: pods ~600 B each (≈ 9 MB at 15,000 pods), workloads ~1.9 KB each with their sparklines; so the route it is. `/search` on the e2e clusters: 6–12 ms; on 15,000 pods + 3,000 Deployments + 100 nodes: **14–80 ms** per query, ~2 KB. In WebKit on that cluster: one request per pause, results ~220 ms after the last key (150 ms of it the debounce), 11 ms average frame lag per key (dev build).
  - **`/` on list pages** keeps focusing the page's own filter (SearchField, older and documented there); elsewhere it opens the palette. ⌘K / Ctrl+K always opens it.
  - **No open-in-new-tab modifier:** the ADR has none; the options are listbox options, not links.
  - **Recent picks** are per user in this browser (`localStorage`), across clusters: a pick keeps its `?cluster=`, so picking it later switches back. Empty, the palette lists the recent picks, the pages of the selected kind, and the clusters (when there is more than one).
  - **Top bar:** a search-field-looking button with the shortcut (⌘K on Apple platforms, Ctrl K elsewhere) from 1024 px, a 44 px icon button below; full screen on phones (< 768 px) with 48 px rows.

## ADR-170: The live demo gets a Docker host, isolated from the server it runs on

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact)
- Context: the live demo shows a k3d cluster only, so visitors never see half of what WatchLog does (ADR-124). The server runs other sites and containers. A WatchLog Docker agent on the server's own Docker daemon would list those containers, read the server's CPU, memory and disks, and see its traffic, which ADR-121 rules out.
- Decision:
  - **A Docker-in-Docker host:** one `docker:dind` container (pinned version) started by the demo kit, with its own daemon and data volume, its own network joined to the k3d network so its agents reach the demo's ingest, no published ports, and caps of 1 CPU and 1 GiB. It must run privileged (dind needs it); it runs only the images the kit pins.
  - **Inside it:** a Compose project `storefront` (a web and an api from podinfo, Redis, PostgreSQL), the WatchLog Docker agent and the integrations collector, both at the kit's version, reporting to a second entry in the demo, a Docker fleet named "demo-docker", seeded by the kit like the cluster. One failure that probable cause names on Docker: a `worker` container OOM-killed every 20 minutes (`oom_limit`, Docker form).
  - **Nothing of the server shows:** the agent runs with `WATCHLOG_NODE_METRICS_SCOPE=cgroup` (ADR-121's switch, set explicitly: a Docker host's `auto` is `host`), so CPU, memory and disks are the dind container's. Network flows need ADR-121's filter in Docker mode: slice 8 adds a Docker-mode option (`WATCHLOG_EBPF_CONTAINER_FILTER`, default off) whose roots are the cgroups of the containers this daemon runs, and the demo turns it on. If that can't be built and measured in the slice, the demo's Docker host runs with flows off and the map says why (ADR-107), rather than record the server's traffic.
  - **The dashboard's cluster switcher** lists both; the k3d cluster stays the one a visitor lands on.
  - Tested first in the kit's server test VM (`deploy/test/server-test.sh` in the kit's repository), never on the server by Claude.
- Alternatives: the server's own daemon with an include filter (rejected: the agent would still read the host's /proc, events and traffic); a k3d node or a pod running dind (rejected: it takes memory from the 3 GiB nodes, ADR-171); a VM on the server (rejected: needs root).
- Consequences: the demo takes up to 1 GiB more on the server. Privileged dind is noted in the kit's DEPLOY.md for the owner.
- As built (v0.5 slice 8, 2026-11-13):
  - **The filter:** `WATCHLOG_EBPF_CONTAINER_FILTER` (`--ebpf-container-filter`, default `false`) reuses the pod filter's kernel side. Its roots are the cgroups of the containers the agent's Docker daemon runs: with the `cgroupfs` driver (Docker in Docker) their parent `docker`, one root that also covers a container started between two scans; with the `systemd` driver each container's scope (their parent `system.slice` holds the host's services). The kernel map holds 16 roots: with more, the filter turns off (logged, `watchlog_agent_flow_pod_filter` 0) rather than leave containers unrecorded, and the agent drops other tasks' flows in user space as it does without the option. No BPF change.
  - **Measured** in a test VM (Docker 29 in `docker:29.0.4-dind` on a VM that also runs a kind cluster and other containers): the filter turned on with one root; in about 5 minutes the kernel kept out 25,721 connections and 49,099 DNS lookups of the VM's other containers and processes, the service map showed only the storefront's and the agents' edges, and 15 connections were dropped in user space (the first seconds, before the agent listed the containers). CPU and memory in `cgroup` scope: 1 CPU and 1 GiB, the Docker-in-Docker container's caps.
  - **The fleet's token:** the backend's seed file gained `clusters` (name, kind, the token's SHA-256 and prefix, never the token), so a demo in demo mode registers its Docker fleet without the API; the kit makes the token on the server. A revoked token or a deleted cluster is not brought back, as for the chart's bootstrap cluster (ADR-069).
  - The agents reach the demo's ingest through the dashboard's node port on the k3d network (`/ingest/` through the web container, which demo mode lets through); dockerd inside listens on its unix socket only (the image's default adds an unauthenticated TCP port).

## ADR-171: The demo kit's shop gains MySQL, MongoDB, Traefik and Kafka, each with a real failure

- Date: 2026-11-13 · Status: accepted (v0.5 slice 0; pre-approved, reviewed after the fact; follows ADR-142)
- Context: ADR-142 gave the demo real services with real failures. The k3d nodes have 3 GiB each (never changed), and the server node already uses about 1.8 GiB.
- Decision:
  - **MariaDB 11.4** (`--innodb-buffer-pool-size=32M`, performance_schema on with small sizes): requests 128 MiB, limit 256 MiB. A small `inventory` writer updates a `stock` table. **Failure:** `inventory-lock`, hourly at :50–:55, opens a transaction, locks the row `inventory` updates (`SELECT … FOR UPDATE`) and sleeps 5 minutes. `lock_waits` names shop/inventory-lock as the holder; probable cause: `application_finding` → the CronJob started at :50.
  - **MongoDB 8.0** as a one-member replica set (`--wiredTigerCacheSizeGB 0.25`): requests 160 MiB, limit 384 MiB, with an `events` writer. **Failure:** `analytics`, hourly at :05–:10, runs an unindexed query on `events` in a loop. `slow_collscan` names shop/analytics; probable cause: `application_finding` → the CronJob started at :05.
  - **Traefik v3** as a second way in: the load generator sends part of its traffic through Traefik to `api`, so the existing frontend → api chain is unchanged. Requests 32 MiB, limit 96 MiB, metrics on :9100. **Failure:** the existing api-outage (:00–:05, :30–:35): Traefik's api service has no server up and answers 503 itself; probable cause: `no_server_up` → `dependency_down` (api scaled to 0).
  - **Kafka 4.1 as a single KRaft node** (`apache/kafka-native`; fallback `apache/kafka` with a 192 MiB heap and a 512 MiB limit): requests 192 MiB, limit 384 MiB, with a producer and an `audit` consumer group (kcat). **Failure:** the audit consumer consumes 40 minutes, then grows until it is OOM-killed and waits 7 minutes before joining again (RabbitMQ's pattern, ADR-142): the group loses its members while lag grows; probable cause: `group_no_members` → `oom_limit` on shop/audit.
  - **Budget:** about 0.6 GiB of requests and 1.4 GiB of limits in all, clients included. Slice 9 measures each node's working set in a k3d with the same 3 GiB nodes, at the worst minute of the hour with everything running. A node must stay under 85 % of its memory. If one service doesn't fit, it is left out of the demo in this order: Kafka, MongoDB, MariaDB, Traefik; pending-review says which and why. Node and server sizes never change. The shop's ResourceQuota may grow to cover the new limits.
  - **The e2e demos** (kind and the Docker host in the e2e VM) get the same services and failures through each integration's e2e script, including MySQL 8.4 next to MariaDB.
- Consequences: the hour's chaos schedule gains :05–:10 and :50–:55; the kit's `status.sh` and `check.sh` list the new CronJobs and services; the seed monitors the four with their default alerts.
- As built (v0.5 slice 9, 2026-11-13; measured in a k3d with the same two 3 GiB nodes, WatchLog from main):
  - **All four fit; none is left out.** MariaDB 11.4 (32 MB buffer pool, performance_schema on with small tables, 40 connections), MongoDB 8.0 (one-member replica set `rs0`, a key file), Traefik v3.6 (its own namespace, the Kubernetes Ingress provider limited to `shop`, empty services allowed as k3s does, metrics on :9100) and Kafka 4.1.1 (`apache/kafka-native`, one KRaft node, plain text). Their data is in emptyDirs, like the demo's PostgreSQL: a new pod makes its database, WatchLog's user and its data again by itself. WatchLog reads MariaDB and MongoDB with users of its own, their passwords in Secrets only the collector may read (as for PostgreSQL, ADR-142); Kafka and Traefik need none.
  - **Changed from the decision, each measured:** MongoDB's WiredTiger cache is 96 MB through `--wiredTigerEngineConfigString` (the smallest `--wiredTigerCacheSizeGB`, 0.25, filled while the events loaded and passed the 384 MiB limit: OOMKilled); its 200,000 events are made on the server, 5,000 per aggregation (a mongosh building them needed about 340 MB, one aggregation of all of them passed the limit). The `events` writer and the `analytics` scan use `mongoimport` and `mongoexport` (Go, a few MiB) instead of mongosh (about 250 MiB; OOMKilled at 160 MiB). Kafka's producer and the `audit` consumer are `rpk`, Redpanda's Go client, instead of kcat: kcat's librdkafka 1.7 can't read offsets from Kafka 4 ("Required feature not supported by broker"), so the group never committed. MariaDB, MongoDB and Kafka prefer the node without the control plane. The load generator's second container sends about one request a second through Traefik.
  - **Memory, everything running and the four failures, nightly-export and slow-backend at once:** MariaDB 164 MiB, MongoDB 256 MiB, Kafka 255 MiB, Traefik 22 MiB, the clients 1–24 MiB each (audit up to its 64 MiB limit, by design). Nodes (working set, of 3 GiB): with the three on the agent node, at most 1.57 GiB on the server node (51 %) and 1.90 GiB on the agent node (62 %); a first run with all three on the server node, nightly-export also running, reached 2.18 GiB there (71 %). Every node stays under 85 %. The demo's own server node uses about 1.8 GiB today, so the preference keeps the three off it. Requests grow by about 0.57 GiB and limits by about 1.36 GiB (Traefik included); the shop's quota went to 6 GiB of limits.
  - **Probable cause, read from the kit's WatchLog (`GET /causes` on each service):** Traefik **likely** `application_finding` (`no_server_up`: shop/api has no server up, Traefik answers 503 itself → shop/api has no pod serving); MariaDB **likely** (`lock_waits` on shop.stock → held by the CronJob shop/inventory-lock); MongoDB **likely** (`slow_collscan` on shop.events → sent by the CronJob shop/analytics, with mongoexport as with mongosh); Kafka **likely** (`group_no_members`: the group audit has no members, its lag growing → shop/audit's pod, OOMKilled). In the test the pod's own cause read as `new_version_oom`, since audit had been rolled out 15 minutes before the kill; on the demo, where it is OOM-killed 40 minutes after it starts and nothing rolls it out, that step is its memory limit (`oom_limit`).
  - **The Docker host (ADR-170) on k3d,** tested here for the first time: its agent now runs on the Docker-in-Docker container's network, since from a network of the inner daemon the k3d node's name doesn't resolve; with that, its storefront's services connected and the worker's OOM kill was named **likely** `oom_limit` (64 MiB).
  - **Probable cause's client for a slow scan** is now the one that sent most of the shape's slow entries in its last 10 minutes, not in the last hour: the demo's hourly analytics runs from a new pod each time, and the previous run's pod, gone by then, would have been named for the first half of the scan (the backend then finds no owner and says "possible").

## ADR-172: Discovery leaves out clients that run a server's image

- Date: 2026-11-13 · Status: accepted (v0.5 slice 10a; pre-approved, reviewed after the fact; refines ADR-132)
- Context: discovery matches by image first (ADR-132), so a pod or container that runs `mysql`, `mongo`, `postgres` or `redis` only for its command-line client was offered as a service: the e2e's `causes-e2e/leak`, the demo's `orders`, `sessions`, `inventory`, `inventory-lock`, `events` and `analytics`. The image can't tell them apart, and the agents don't read listening sockets.
- Decision:
  - **The eBPF flows decide:** a candidate that connected out on one of its type's ports in the last 24 hours (a connect, failed ones too, or bytes on a connection it holds open), and that no established connection reached on any of them, is a client and isn't offered. One instant query pair per cluster from discovery (`watchlog_flow_connections_total` / `watchlog_flow_bytes_total` by source, `watchlog_flow_connect_latency_seconds_count` / bytes by destination).
  - **A port it declares (a pod's `containerPort`) or publishes (Docker `-p`) keeps it,** for every type: proxies (Nginx, Traefik) connect out on the very ports they serve.
  - **Without flows nothing is hidden:** no eBPF, a VictoriaMetrics error, or a client whose last connection is older than a day.
  - Identities as the flows name them: the workload (`namespace/kind/name`) on Kubernetes, the container name on Docker. A replica set in one workload (MongoDB, Kafka, a PostgreSQL StatefulSet) is reached by its own members, so it stays.
- Measured (e2e stack): 7 candidates became 4 (`shop/orders`, `shop/sessions`, `causes-e2e/leak` left out; every server kept), the discovery answer in 47 ms.
- Known limit: a replica in a workload of its own that only connects to its primary, and whose readers are outside the cluster or host, reads as a client; Add manually still monitors it.

## ADR-173: WatchLog Cloud opens before the launch, as a beta in release 0.6.0

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact; brings SPEC §13 Phase 5 forward)
- Context: the live demo gets a few visitors a day without any promotion, and the launch (2 December 2026) should let a visitor start in minutes without running anything. Stripe can't be switched on until a payment entity exists (SPEC §16), which takes longer than the code.
- Decision:
  - **Scope:** Phase 5 (SPEC §13) is built now, before the launch: multi-tenancy, accounts, onboarding, plans and limits, billing (built and tested, not live), lifecycle emails and funnel, the Cloud admin, the production kit and the trust pages. It ships in the public release **0.6.0**.
  - **One switch:** `WATCHLOG_EDITION=cloud` turns on every Cloud-only path (signup, OAuth, the wizard's Cloud parts, entitlements and limits, Redis quotas, funnel events, lifecycle emails, the internal admin and billing APIs, the SSRF egress policy). Unset (or `community`), the product behaves exactly as 0.5.0: one default org, no limits (ADR-151), no signup, no billing. The Cloud routes answer 404 there, and a test pins that set. The Helm upgrade test from 0.5.0 must pass unchanged.
  - **How Cloud opens:** invite waves from the existing waitlist, then public signup (a setting in the Cloud admin).
  - **Pro free during beta:** while `BILLING_LIVE=false`, an org can switch to Pro without a card (`source: beta`): 30 days of data, unlimited clusters and nodes, up to 10 users. Users get 14 days' notice by email before billing starts. Prices (SPEC §3.2) don't change.
  - **What Pro gives in 0.6.0:** the limits above and email support. The multi-cluster view, SLO reports and basic anomaly detection are Phase 6: pages and the site say "coming to Pro", never that they're included.
  - **Where code goes:** tenancy, accounts, onboarding, entitlements, limits, funnel, lifecycle emails and the Cloud admin's API are product code in this repository, behind the switch. The billing service, the production Compose kit and Cloud operations are in the private Cloud repository; the marketing and trust pages are in the site's. The public `deploy/cloud/` placeholder (a Caddy layout, SPEC §5.5's first draft) is removed; SPEC §5.5 describes what runs instead.
  - **Not in this release:** a shared Telegram bot with a webhook (channels keep their own bot tokens), the Phase 6 Pro features, live billing, a paid pen test, a region claim before the owner confirms where the server is.
- Alternatives: Cloud after the launch (rejected by the owner: visitors already ask for it); a separate Cloud codebase (rejected: SPEC §3.4, self-hosters run the same code).
- Consequences: SPEC §3, §5.4, §5.5, §10 and §13 are updated. Every Cloud slice keeps Community's behaviour pinned by the existing suites plus a "Community unchanged" route test.

## ADR-174: Tenancy: org_id on every tenant row, Row-Level Security under a role that can't bypass it, the org per connection checkout

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact; completes ADR-035)
- Context: ADR-035 put `org_id` on the first tables and left Row-Level Security for Phase 5. Measured on the 0.5.0 schema: `clusters`, `alert_channels`, `alert_rules`, `alert_states`, `api_tokens`, `audit_events`, `discovery_ignores`, `integration_events`, `integration_probes`, `integrations`, `invites`, `mcp_calls`, `memberships`, `notifications`, `seed_services` and `silences` carry `org_id`; `objects`, `change_markers`, `agent_instances`, `cluster_tokens`, `ingest_errors`, and `integration_collectors` carry only `cluster_id`; `integration_credentials`, `notification_alerts`, `api_token_events` reach their org through a parent row. 64 backend files share one Kysely instance on one pg pool.
- Decision:
  - **`org_id` on every tenant row:** the cluster-keyed and parent-keyed tables gain `org_id NOT NULL`, backfilled from their cluster or parent in the same migration, with a composite foreign key to their parent where one exists (`(cluster_id, org_id)` → `clusters`), so a row can't name one org's cluster under another org.
  - **RLS on every tenant table:** `USING (org_id = current_setting('watchlog.org_id', true)::uuid)` with the same `WITH CHECK`. An unset or empty setting matches nothing.
  - **Two database roles in Cloud:** the request path connects as `watchlog_app` (not the owner, `NOBYPASSRLS`); migrations and a small allow-listed `systemDb` connect as the owner. `systemDb` is used only for what must work before the org is known or across orgs: session, API-token, cluster-token, invite, email-token and OAuth-identity lookups; the ingest token check; the workers listing orgs; the internal billing and admin APIs. A test fails if any other file imports it.
  - **The org per connection checkout:** an `AsyncLocalStorage` holds the request's org; the pool given to Kysely sets `watchlog.org_id` on every checkout (empty outside an org context), so each query and transaction runs under the right org without changing the 64 modules. Workers run each org's work inside `withOrg(orgId, …)`.
  - **Community:** the same migrations add the columns and policies, but the backend keeps connecting as the owner, which RLS doesn't apply to (no `FORCE`), and the data-access layer keeps scoping by org as today. Behaviour and performance are 0.5.0's.
  - **VictoriaMetrics:** one guard, `clusterForOrg(orgId, clusterId)`, authorises a cluster before any query, SSE stream, MCP tool or export; the VictoriaMetrics client accepts only its result (a branded type), and adds `extra_label=cluster_id` as before (ADR-028). Ingest already takes the cluster from the token (ADR-026).
  - **Per-org limits in Redis (Cloud):** API and MCP rate limits and ingest quotas are keyed by org in Redis, so they hold across backend replicas (ADR-027's open item). Community keeps its in-memory buckets.
- Alternatives: a Kysely transaction per request passed through every module (rejected: touches every module and holds a transaction for SSE streams); `SECURITY DEFINER` functions for the pre-org lookups (rejected: more SQL to review than one allow-listed module); a database or schema per org (rejected: thousands of Free orgs).
- Consequences: one extra `set_config` round trip per checkout in Cloud (measured in slice 1). Isolation has two layers that are tested separately (ADR-182): the queries' own `org_id` filters, and RLS under `watchlog_app` with the filters removed.
- As built (Cloud slice 1, 2026-11-13; measured on the e2e PostgreSQL 16 with its 0.5.0 data):
  - **The switch:** `WATCHLOG_EDITION` (`community` by default, `cloud`; anything else stops the start). Cloud needs `DATABASE_SYSTEM_URL` (the owner) beside `DATABASE_URL` (`watchlog_app`) and refuses the same URL in both; Community ignores `DATABASE_SYSTEM_URL` and opens one pool, as in 0.5.0. `registerCloudOnly` (`plugins/edition.ts`) registers a plugin only in Cloud and marks its routes `cloudOnly`; slice 1 has none, so Community's 404s for `/api/v1/auth/signup`, `/api/v1/funnel`, `/internal/*` are simply unknown routes, pinned by a test.
  - **Measured first:** besides the tables in Context, `k8s_events` (partitioned, 14,125 rows) carries only `cluster_id`, and `telegram_verifications` reaches its org through its channel. No orphan rows (every `cluster_id` has a cascading foreign key) and no row whose `org_id` differs from its cluster's.
  - **The migration** (`1794700000000_tenancy-rls`): `org_id NOT NULL` on the 7 cluster-keyed and 4 parent-keyed tables, backfilled in the same transaction (under a second on the e2e copy); unique `(id, org_id)` on `clusters`, `integrations`, `notifications`, `api_tokens`, `alert_channels` and composite foreign keys to them, also on the 6 tables that already had both columns. RLS with one policy, `org_isolation`, on 27 tenant tables and `orgs` (on its `id`). The ADR's `current_setting(…)::uuid` became `nullif(current_setting('watchlog.org_id', true), '')::uuid`, since `''::uuid` is an error and the pool sets `''` outside an org. The partitions of `k8s_events` get RLS without a policy (readable only through the parent); `ensureEventPartitions` does the same for each new one.
  - **0.5.0's inserts unchanged:** the new `org_id` columns default to the connection's org (Cloud), and a `BEFORE INSERT … WHEN (NEW.org_id IS NULL)` trigger (`SECURITY DEFINER`, reading the parent as the owner) fills it from the cluster or parent row otherwise (Community). RLS's `WITH CHECK` and the composite keys still refuse a row of another org's cluster. Cost, measured: about 2.5 µs per inserted row (20,000 `change_markers` rows: 184 ms with the trigger, 134 ms with `org_id` given), so the ingest hot paths (objects, change markers, Kubernetes events, heartbeats) give the token's `org_id` and never run it; the rarer writes (cluster tokens, ingest errors, collectors, the parent-keyed tables) still rely on it.
  - **Global, not tenant data:** `users`, `sessions`, `password_resets` (a user spans orgs), `server_settings` (ADR-093), `secret_key_check`, `alert_worker_heartbeats`, `alerting_periods`, `retired_cluster_tokens` (hashes only, read by the ingest token check) and `pgmigrations`. The isolation suite fails on any other table without `org_id`.
  - **The installation's settings in Cloud:** every `/api/v1/settings/*` route answers 404 in Cloud (`communityOnly`, checked in an `onRequest` hook), except reading the system namespaces and who may read logs: an org's Owner must not change, or read, the email server, the public address or Telegram's settings that every org shares. Per-org versions of the namespaces and logs settings are left for a later slice; until then Cloud reads the installation's.
  - **`watchlog_app`: a documented step of the Cloud kit**, not created by a migration: `CREATE ROLE watchlog_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS` once, as a superuser, with the operator's password. Creating roles needs `CREATEROLE`, which the owner shouldn't have, and the password is the operator's secret. In Cloud, `migrate` (as the owner) then grants it `SELECT, INSERT, UPDATE, DELETE` on every table (none on `pgmigrations`) after each run, and stops if the role is missing or can bypass RLS; the backend refuses to start when `DATABASE_URL`'s role is a superuser, has `BYPASSRLS` or owns the tables. Community never needs the role.
  - **The org per checkout:** an `AsyncLocalStorage` scope per request, entered by the first `onRequest` hook (a callback hook, so the rest of the request, its streams and timers run inside it). The session, API token, demo, service identity and cluster token bind the org (`bindOrg`); binding a second org in one request throws. The Cloud pool runs `SELECT set_config('watchlog.org_id', $1, false)` on every checkout, before Kysely's `BEGIN`, so a transaction keeps its org and the next checkout overwrites it. **Cost, measured:** the call itself takes about 0.2 µs in PostgreSQL (100,000 in a loop: 58 ms against 40 ms for an empty loop); the cost is one round trip: from the Mac through the VM's port forward a one-row query went from 0.31 ms to 0.62 ms (3,000 queries, twice). On a Compose network a round trip is far shorter; skipping the call when a connection already carries the org is the optimisation if it ever matters.
  - **`systemDb`:** the owner's Kysely, used by sign-in, first-run setup, invite and password-reset links and forgot-password, the session, API token, demo and service lookups, the cluster token cache, event partitions, the seed and bootstrap cluster, and in the alert worker for listing orgs, pruning, the outbox, Telegram polling and the API token jobs. Each org's evaluation runs inside `withOrg` on the app connection. Modules receive it by name (`systemDb`), and a test allow-lists the 12 files that use it and checks the wiring never passes it as a module's `db`.
  - **`clusterForOrg`** replaces `findCluster` (24 callers) and returns the row with `scope`, a branded `ClusterScope` that `VictoriaClient.query`, `queryRange` and `write` require. The only other maker, `authorisedScope`, is allow-listed by a test to 8 files: the guard, ingest (the token's cluster), and the reads whose cluster comes from the org's own rows (alert rules and charts, service pages, discovery).
  - **Per-org Redis buckets: blocked.** No Redis client is in the lockfile and slice 1 may add none, so the API, MCP and ingest limits keep 0.5.0's in-memory buckets in both editions, keyed as before (per token, agent and cluster). They hold for one backend replica; the Cloud kit runs one until a Redis client is allowed.

## ADR-175: Accounts in Cloud: email and password, GitHub and Google, TOTP, Turnstile, many orgs per user

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact)
- Context: SPEC §10.1 wants signup in 60 seconds; an infrastructure tool needs 2FA; Community keeps its first-run setup and invites (ADR-140).
- Decision:
  - **Signup** (Cloud only): email and password (argon2id as ADR-034, at least 10 characters, a strength meter), or GitHub or Google. No card, no company field. A verification link is sent; it doesn't block onboarding, and an account not verified in 7 days can sign in only to verify. Signup creates the user, an org named after the email's local part (renamable), an Owner membership and Free entitlements.
  - **Breached passwords:** the Have I Been Pwned range API with k-anonymity (only the first 5 hex characters of the SHA-1 leave), through `fetch` with a 2-second timeout; when it can't answer, signup goes on and the check is logged as skipped.
  - **OAuth** (GitHub and Google) through `fetch`: the authorization-code flow with PKCE and a `state` bound to a short-lived HttpOnly cookie. Accounts are linked only by the provider's id; an existing email account is linked only after the user signs in with its password, never by matching emails. GitHub's primary email must be verified.
  - **TOTP 2FA** (`otpauth`, RFC 6238, 30 s, ±1 step, a used step not accepted twice), its secret encrypted with AES-256-GCM under `WATCHLOG_SECRET_KEY` (ADR-079), 10 single-use recovery codes stored as SHA-256. Optional for everyone; required for Owners of orgs whose entitlements come from billing (not the beta). Sign-in after the password or OAuth step asks for the code; the session records `mfa_passed_at`.
  - **Turnstile** on signup, password reset and resend-verification, verified server-side with `fetch`; off when `TURNSTILE_SECRET_KEY` is unset (tests, development).
  - **Abuse:** signups limited per IP (5 an hour) and per email domain (20 a day), a built-in list of disposable-email domains extendable by a file, login and reset rate-limited per IP and per account; messages never reveal whether an email has an account.
  - **Sessions:** ADR-033's, rotated at sign-in and at the 2FA step, listed and revocable in Settings › Security; always `Secure` in Cloud.
  - **Orgs:** a user may belong to several orgs; the session carries the current one, and an org switcher appears when there are two or more. Invites (ADR-140) work across orgs: an existing account joins with one click. Cloud Free has one user, so invites ask to try Pro first.
  - **Community:** none of this is reachable; `/setup` and invites work as in 0.5.0.
- Alternatives: an external identity service (rejected: another dependency and another place for data); magic links instead of passwords (rejected: mail delays hurt the 60-second target).
- Consequences: new tables `user_identities`, `email_tokens`, `recovery_codes`; `users` gains `email_verified_at`, `totp_secret`, `disabled_at`; `sessions` gains `mfa_passed_at` and `org_id`. GitHub and Google OAuth apps and the Turnstile keys are the owner's to create.

- As built (Cloud slice 2a, 2026-11-13; the backend only, the pages are slice 2b):
  - **Where:** `backend/src/modules/accounts/` (routes, checks, OAuth, TOTP, the account service), registered through `registerCloudOnly`, so every route answers 404 in Community. Migration `1794800000000_cloud-accounts`: `user_identities`, `email_tokens`, `recovery_codes`; `users` gains `totp_secret`, `totp_enabled_at`, `totp_last_step`, `disabled_at`; `sessions` gains `current_org_id`, `stage`, `mfa_passed_at`, `mfa_attempts`, `ip`, `user_agent`; a stub `entitlements` (org, plan, source; RLS on) that slice 4 extends.
  - **`sessions.current_org_id`, not `org_id`:** the isolation suite treats a table with `org_id` as tenant data under RLS, and a session is the user's, read before any org is known. The session lookup takes the current org while the user is still a member of it, else the first membership, so a removed membership never strands a session.
  - **Two accounts with one address (scenario 5):** `users.password_hash` is nullable for GitHub and Google accounts, and the unique email index covers password accounts only. An OAuth sign-up with an address that has a password account makes a separate account; the password account links GitHub or Google from its signed-in session. Community's users all have passwords, so its constraint is unchanged. Password sign-in and "Forgot your password?" look at password accounts only.
  - **Signup never says an address is taken:** the same `201 {accepted, verificationSent}` either way; a new account also gets its session, an existing address gets an email ("someone tried to sign up with your address") instead. The difference left, a session or none, is slowed by Turnstile and 5 signups an hour per address.
  - **Checks:** Turnstile fails closed when Cloudflare can't be reached (the form can be retried; bots stay out). HIBP failing open is logged as `breached-password check skipped`. OAuth sign-ups count against the per-address and per-domain limits and the disposable list, without Turnstile (the provider's sign-in is the check). The limits (signups, resends 3 an hour per user, resets 3 an hour per account, password attempts 20 per 15 minutes per account) are in-memory windows, held by one replica, like the other limits until a Redis client is allowed (ADR-174).
  - **Verification:** links last 24 hours (resend for a new one); the 7-day gate counts from the account's creation. GitHub's primary and Google's address must be verified, and such accounts start verified.
  - **Gates:** in Cloud, `requireUser` answers 403 with `mfa-setup-required` (an Owner of an org whose entitlements' `source` is `billing`, without TOTP; checked first) or `email-verification-required` (unverified after 7 days). `/me`, the account, the sessions list and the verification and 2FA routes still answer. The gates apply to sessions; API tokens are only made from a session, so a gated user can't make new ones.
  - **The 2FA step:** after the password or OAuth step, a session with `stage = 'mfa'` (10 minutes, 5 wrong codes end it) in its own cookie `wl_mfa` (HttpOnly, path `/api/v1/auth/2fa`); the code turns it into a new full session with `mfa_passed_at`. A recovery code works in place of a TOTP code. Turning 2FA on rotates the session too. Owners of billed orgs can't turn it off.
  - **OAuth:** the state cookie `wl_oauth` (path `/api/v1/auth/oauth`, 10 minutes) holds the state, the PKCE verifier and the intent, sealed with AES-256-GCM under `WATCHLOG_SECRET_KEY`. The callback redirects to the pages: `/` (or a same-site `next`), `/signin/2fa`, `/signin?error=<code>`, `/settings/security?linked=<provider>` or `?error=<code>`. A provider account linked to another user isn't moved (`identity-taken`); unlinking the last way to sign in is refused. Env: `WATCHLOG_GITHUB_CLIENT_ID`/`_SECRET`, `WATCHLOG_GOOGLE_CLIENT_ID`/`_SECRET`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`, `WATCHLOG_DISPOSABLE_DOMAINS_FILE` (docs/site/configuration.md).
  - **Orgs:** `GET /orgs` and `POST /orgs/:id/switch` (404 for an org the user isn't in). Joining from an invite with an existing account (`POST /invites/:token/join`) needs the invite's address. Removing a user in Cloud ends their membership, tokens and sessions in that org; the account goes only with its last org (Community deletes the account as before).
  - **Cloud Free and invites:** an org whose entitlements say `free` gets `409 plan-limit` on invite now; an org without an entitlements row (none is made outside signup yet) has no limit until slice 4 replaces this with the entitlements' user limit.
  - **The funnel:** `signup_completed` (and `email_verified`) go through `recordFunnelEvent`, which only logs: `funnel_events` belongs to slice 6 (ADR-179), which replaces that function's body.
  - **TOTP:** `otpauth` 9.5.2, exact (9.6.0 was younger than two weeks). Secrets are bound to their user with associated data, and `rotate-secret-key` re-encrypts them.
  - **Cookies:** Cloud sets `WATCHLOG_COOKIE_SECURE=always` by default and refuses another value. Sign-in in Cloud ends the session the browser came with.

- As built (Cloud slice 2b, 2026-11-13; the pages):
  - **The edition in the web:** the auth store asks `GET /auth/config` next to `GET /setup`; an answer means Cloud, a 404 (or any failure) means Community, so a Community install makes one extra request that 404s and shows exactly the 0.5.0 pages. Cloud never sends anyone to first-run setup (`/setup` still answers on the backend). Routes carry `meta.cloud` (Community sends them to sign-in), `meta.anyone` (a public page a signed-in user may open: the invite and the verify link, Cloud only) and `meta.gate`; a gated account sees only the page that lifts its gate, and any 403 `mfa-setup-required` / `email-verification-required` sends it there.
  - **Pages:** `/signup` (after `Signup.dc.html`), `/login` gains the providers, the OAuth `?error=` messages and "Create an account" in Cloud; `/signin` and `/signin/2fa` (the callback's paths), `/verify-email/:token`, `/verify-email` (the 7-day gate), `/setup-2fa` (Owners of billed orgs), Settings › Security (`/settings/security` redirects to the tab), the org switcher, the one-click join on `/invite/:token`. Every account error code and OAuth error has a plain message in `cloud.errors.*`; the server's English `detail` is never shown.
  - **Differences from the screen:** no "Hosted in the EU" chip (no region until the owner confirms it); the name field is left out, as on the screen (the org is named after the email's local part); the Turnstile box is Cloudflare's own widget, not the drawn one; the Terms and Privacy links point at `https://watchlog.io/terms` and `/privacy`, which slice 8 writes.
  - **No QR library:** the web has none and adds none, so 2FA setup shows the secret (in groups of four, with copy) and an `otpauth://` link that a phone's authenticator opens. Recovery codes are shown once, with copy, a `.txt` download and an "I saved them" tick before Done.
  - **Strength meter:** length and the mix of character kinds, no dictionary library; a hint only, the backend decides (10 characters, HIBP).
  - **Turnstile and CSP:** Cloudflare's script (`https://challenges.cloudflare.com/turnstile/v0/api.js`, explicit render) is added only by a page that shows the widget (sign-up, "Forgot your password?", resend) and only when `turnstileSiteKey` is set. The SPA has no CSP today (helmet's applies to API answers only); the CSP of slice 6 (ADR-181) must allow `script-src` and `frame-src https://challenges.cloudflare.com`.
  - **Org switch and join** reload the app from `/` (a full load), so no store keeps the old org's data. The switcher is the cluster switcher's searchable list (the same keyboard and screen-reader behaviour); on phones it is in the filters sheet.
  - **Verification:** a banner over every page until the address is verified, with the date from `verifyBy` and "Send a new link" (Turnstile on first press when on); it can be hidden for the page view.

## ADR-176: Onboarding in Cloud: the wizard, a live checklist over SSE, troubleshooting, the live demo as the sample

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact)
- Context: SPEC §10.2 targets 3 minutes from signup to data; the design references are the six Cloud screens.
- Decision:
  - **The wizard:** Kubernetes or Docker → a name (prefilled) → one command with the token in it (Helm, kubectl manifest, docker run, Compose) → the live checklist → "Open dashboard" → an optional alert channel (Slack, Telegram, email prefilled with the user's verified email).
  - **The live checklist:** `GET /api/v1/clusters/:id/onboarding-status` as Server-Sent Events (JSON polling fallback), from data the backend already has: agent heartbeats (and how many nodes), the cluster agent (Kubernetes), the first metrics, eBPF on or why not (ADR-107), the service map's first edges. A step's detail is in plain words; nothing is invented while waiting.
  - **The kubectl manifest** is fetched with a separate install code (`wl_ic_`, 256 bits, SHA-256 at rest, one cluster, valid 24 hours, revoked with the cluster token), never the cluster token in a URL; the nginx vhost logs the path without the query string.
  - **Troubleshooting** after 2 minutes without a heartbeat (SPEC §10.3): the copy-paste diagnostics for the chosen platform, the common causes with fixes, and "Get help installing", which mails support with the cluster id.
  - **The sample:** "Look around a sample organisation" opens the read-only live demo (`demo.watchlog.io`) in a new tab. No demo data is copied into Cloud, so isolation has nothing to except.
  - **First-week checklist** on the overview: connect a channel, invite a teammate, connect an application, try MCP with your AI, and see your first explained problem. Each step is a funnel event, and the card hides once all are done or dismissed.
  - **Community:** the existing "Add cluster" flow gains the live checklist (the same endpoint), since it helps self-hosters too; signup, the sample link and the first-week card are Cloud only.
- Alternatives: a sample org inside Cloud fed with the demo's data (rejected: a second copy of the demo's metrics and an exception in the isolation suite); the token in the manifest URL as SPEC §10.2 first said (rejected: URLs end up in logs and shell history).
- Consequences: SPEC §10 is updated. The wizard's timings are measured in slice 9 on kind and Docker.
- As built (Cloud slice 3, 2026-11-13):
  - **The checklist** (`modules/onboarding/status.ts`), both editions, through `clusterForOrg`: measured first on the e2e stack, where node and Docker agents report `mode` `node`/`docker` and the cluster agent `mode: cluster`, `node: cluster-agent`, and eBPF as `enabled`, `unsupported` or `disabled` with a reason and a cause (ADR-107). The steps: agents seen in the last 3 minutes (nodes or hosts, the cluster agent apart); first metrics, `count(watchlog_node_cpu_count)` and `count(watchlog_container_memory_working_set_bytes)` in VictoriaMetrics, asked only once an agent has reported; eBPF done when every node or host agent has it, else `off` with the first agent's reason, cause and the service map's fix command; the map done at its first edge, counted with the map's own `buildGraph` over 10 minutes of flows, and `off` when no agent has eBPF (the map is then drawn from the topology). A step's state is `waiting`, `done` or `off`; `ready` (first metrics) makes "Open dashboard" primary; `complete` (nothing waiting) ends the stream.
  - **The stream:** the same route with `Accept: text/event-stream` (as the logs follow, ADR-167): `retry: 5000`, a `status` event when the checklist changes (polled every 3 s on the server), a ping every 15 s, `end` with `complete`, `gone` or `limit` (10 minutes; the page opens it again). The page falls back to the JSON every 5 s when the stream fails before its first event. Classified as an `org` route and a stream in the isolation suite.
  - **The kubectl manifest is the agent chart rendered at build time:** `scripts/render-install-manifest.sh` runs `helm template` once into `backend/assets/install-manifest.yaml` (committed; CI renders it again and fails on a difference; the backend image ships it), adds the `watchlog` Namespace with the privileged PodSecurity label and the namespace on every namespaced object, and leaves placeholders for the endpoint, the token, the image registry and tag. **The pod map's CA and certificate can't be pre-rendered:** the chart makes them with `genCA` at install time, and one rendered file would give every Cloud cluster the same private key. The backend makes a new ECDSA P-256 CA and service certificate for every download (`modules/onboarding/x509.ts`: the few DER structures of an X.509 v3 certificate written by hand on `node:crypto`, since the backend has no certificate library and may add none); OpenSSL, Node's `X509Certificate` and Go's `crypto/x509` (the agents' TLS) verify the chain and the service name. Applying the manifest again replaces the pair; both agents read the new one when their Secret volume updates. Rendering per request with `helm` (no helm binary in the image) and a Job that makes the certificate (agent changes) were the alternatives.
  - **Install codes:** `install_codes` (RLS, composite key to the cluster, deleted with its token): the code's SHA-256, and the token encrypted with AES-256-GCM under a key derived from the code (HKDF-SHA-256 with the cluster id), so the database alone can't give the token back; the row id is the associated data. Issued with the cluster in Cloud (Kubernetes only), and with each new token; issuing or revoking a token deletes the cluster's codes (a rotation); a cluster's expired codes go when a new one is made. `GET /install.yaml?code=` is Cloud-only, at the root of the ingest address, looked up through `systemDb` (allow-listed), answers the YAML with `no-store`, and 404 for an unknown, expired or rotated code. Every request log line masks `code=` values (`requestWithoutCodes`; OAuth's code too).
  - **Install commands:** Community's answer is 0.5.0's (Helm or `docker run`). Cloud adds `kubectl` and `installCodeExpiresAt` for Kubernetes and `compose` (the `docker run` command as a Compose service) for Docker. The address is `WATCHLOG_INGEST_URL` (documented now; it existed). A `kubectl` install reports the release `watchlog/watchlog-agent` like Helm's, so an eBPF fix offers `helm upgrade`; such installs re-apply the manifest instead (left as is).
  - **The wizard** (`/onboarding`, Cloud, outside the app shell): after `Choose.dc.html` and `Install.dc.html`. The name is prefilled from the org's slug (`<slug>-prod` or `<slug>-hosts`, `my-cluster` without one). The cluster id goes into the URL; the token is shown once, so a reload offers "Get a new command" (a new token; the earlier one keeps working). Sign-up goes to the wizard, and so does the overview of a Cloud org with no cluster (for Owners and Admins), which covers the OAuth sign-up landing on `/` without a backend change. The alert step appears with the first metrics and reuses Settings' channel cards (Slack, Telegram) and the email form, prefilled with the verified address. Troubleshooting opens after 2 minutes on the page without a heartbeat; "Get help installing" is a `mailto:` to `WATCHLOG_SUPPORT_EMAIL` with the cluster id; the sample link opens `WATCHLOG_SAMPLE_URL` (default `https://demo.watchlog.io`) in a new tab. `GET /auth/config` gives both.
  - **Community's Add cluster:** the checklist under the install command, nothing else.
  - **The first-week card** (Cloud): `GET /onboarding/first-week` reads each step from the org's rows: a channel exists; a second member or an invite; an application monitored; an MCP call; an alert with a cause. Cloud Free's invite step says Pro is needed and links to `/settings?tab=billing` (Plan & billing comes in slices 4–5). `onboarding_states` (per user and org) keeps the dismissal and which steps were reported. The steps differ from `Dashboard.dc.html`'s (it has "Install the agent" and no "explained problem"): the ADR's five are built.
  - **The funnel:** server-side `cluster_created`, the first heartbeat and first metrics (from the checklist, once per cluster and process, for clusters made in the last day), the first-week steps (once per user) and the dismissal; the page sends `install_command_copied`, `onboarding_dashboard_opened`, `onboarding_sample_opened`, `onboarding_help_opened` and `onboarding_troubleshooting_shown` through a Cloud-only `POST /api/v1/funnel` that accepts only those names. All go through `recordFunnelEvent`, which logs until slice 6.
  - **Measured on kind and Docker** (slice 3's quick look; the backend on the Mac in Cloud mode, images already on the nodes, the command run as soon as the cluster was made): kind (3 nodes, Helm) agent and cluster agent +2.5 s, eBPF +2.5 s, first metrics +32 s, service map +47 s; Docker (`docker run`) agent and eBPF +1.5 s, first metrics +31 s, service map +31 s. The first metrics wait for the agents' first remote write. Slice 9 times the whole flow from the landing page.
  - **No region** on any page (the screens' "Hosted in the EU").

## ADR-177: Plans and entitlements: what each plan allows, how limits answer, two retention tiers

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact; uses ADR-027's 402)
- Context: SPEC §3.2 sets the plans; the product must enforce them without knowing about Stripe.
- Decision:
  - **Entitlements:** one row per org (`plan`, `clusters`, `nodes`, `users`, `retention_days`, `pro_features`, `beta_until`, `source`: `beta`, `billing` or `staff`), written only through the internal API by the billing service or staff. The product reads it, cached for 60 seconds. Community has no row and no limits.
  - **Defaults:** Free 1 cluster or Docker fleet, 5 nodes, 3 days, 1 user; Pro unlimited clusters and nodes, 30 days, 10 users.
  - **Limits:**
    - A cluster over the plan: `POST /clusters` answers 409 `urn:watchlog:problem:plan-limit`.
    - A node over the plan: ingest answers **402** for an agent instance the org hasn't seen in the last 24 hours, never for one already sending (ADR-027).
    - A user over the plan: invites answer 409 `plan-limit`.
    - The UI shows a plain banner with the count and the way out, and the Owners get one email per limit and day.
  - **Downgrade:** data is never deleted before its retention runs out. Nodes and clusters already sending keep sending for 14 days; then the nodes beyond the plan, newest first, get 402. The banner counts the days.
  - **Usage:** a job records each org's distinct sending nodes and Docker hosts every hour in `usage_hourly`; an internal API returns the hourly counts and the 95th percentile for a period (the bill, SPEC §3.3).
  - **Retention tiers:** two VictoriaMetrics instances, `vm-3d` and `vm-30d` (SPEC §5.4). Ingest writes to the org's current tier. After a plan change, queries read both for the old tier's retention and merge series by their labels, preferring the current tier's points. The cost per node of each tier is measured in slice 9 and recorded here.
  - **Pro features:** `pro_features` gates only what is built. In 0.6.0 that is nothing beyond the limits; Phase 6 features check it when they arrive.
- Alternatives: 402 for every write over the limit (rejected: an autoscaling spike would blind a paying team); one VictoriaMetrics with per-series retention (rejected: VictoriaMetrics' single-node version has one retention per instance).
- Consequences: Community is untouched (no row, no checks). SPEC §3.2, §3.3 and §5.4 note the details.
- As built (Cloud slice 4, 2026-11-13):
  - **The table:** `entitlements` gains `clusters`, `nodes`, `users` (NULL is unlimited), `retention_days`, `pro_features`, `beta_until`, `grace_until`, `previous_retention_days` and `retention_changed_at` (migration `1795000000000_cloud-entitlements`, which fills the plans' defaults into the rows signup made). Signup now writes Free's limits. An org without a row (made by first-run setup in Cloud, or by hand) reads as Free's defaults: a missing row never means unlimited. Enterprise defaults to unlimited with 30 days (the 30-day tier); staff set its contract's numbers. New tenant tables, all under RLS: `usage_hourly`, `plan_limit_hits` (a limit met, once per subject and day) and `plan_limit_emails` (the day's email, claimed).
  - **The cache:** `EntitlementsService`, 60 seconds per org, on `systemDb`: ingest and the metrics tiers read it outside a request's org (ADR-174's allow-list). A write through the internal API invalidates it at once in that process; another replica sees it within 60 seconds.
  - **The internal API** is its own Fastify app on its own listener, `WATCHLOG_INTERNAL_HOST:WATCHLOG_INTERNAL_PORT` (default `HOST`:4082), off without `WATCHLOG_INTERNAL_TOKEN` (at least 32 characters; Cloud only, like `_PREVIOUS`). The public listener has no `/internal` routes (404, as in Community). Every request, unknown paths included, needs `Authorization: Bearer <token>`: SHA-256 of the given value against both the token and the previous one with `timingSafeEqual`, both compared on every call. Routes: `GET` and `PUT /internal/orgs/:id/entitlements` and `GET /internal/orgs/:id/usage?from=&to=` (shapes in the slice notes). `PUT` replaces the entitlements: `plan` and `source` (`beta`, `billing`, `staff`) are required, each limit not given takes the plan's default, `betaUntil` not given clears it, and `orgs.plan` follows. Unknown org: 404.
  - **409:** `POST /clusters` over `clusters` and `POST /users/invites` over `users` (members plus open invites) answer `urn:watchlog:problem:plan-limit` with `code`, `limit` (`clusters`, `users`) and `max`; `ProblemSchema` gained the two optional fields. The pages show their own words for each limit, with the way out (Settings › Plan & billing).
  - **402:** an agent instance is the cluster and its `X-WatchLog-Agent` (the hostname, which heartbeats record as `agent_instances.node`). The cluster-agent, integrations collectors (`integrations…`) and the logs and integrations endpoints are never checked. Each org's set of instances seen in 24 hours is loaded on its first request and refreshed every 60 seconds in the background while the stale set answers, so a write never waits for PostgreSQL. **Measured: 218 ns per check (200,000 checks, one PostgreSQL read).** A new instance is admitted while the set has room (and added at once); otherwise 402, recorded once an hour per instance. 402 is not an ingest error (`isIngestError`): it would read as "data delayed" for the nodes still sending and cost a write per refusal. The agent already drops a 402 batch (ADR-022).
  - **Downgrade:** a lower node or cluster limit starts `grace_until` = now + 14 days (a second lowering keeps the running grace; a raise ends it). During it every instance seen in 24 hours keeps sending and only new ones beyond the plan get 402; after it, the oldest instances up to the limit (by `agent_instances.created_at`) keep sending and the newest get 402. Clusters over the plan keep sending after the grace (the decision names nodes only); the banner counts them during the grace. Data stays until its tier's retention ends.
  - **Usage:** the alert worker's `usage` task, every 5 minutes: on `systemDb`, each org's instances with `last_seen_at` in the current hour, split into `nodes` (mode `node`) and `docker_hosts` (mode `docker`), never the cluster-agent; each org's row is upserted inside `withOrg`, keeping the higher count (the count only grows within an hour, since an agent that stopped keeps its last time). Measured first on the e2e data: one `agent_instances` row per cluster and node, its `last_seen_at` moved every 15 seconds, no history. An hour without a row (no agent, or the worker down) counts as 0. The 95th percentile is by nearest rank over every hour of the period: 10 nodes for 696 hours and 40 for 24 is 10. The plan page's period starts at the month or the org's creation, whichever is later.
  - **Emails:** the worker's `plan-limit-emails` task, every 5 minutes: each org and limit with hits today (UTC) and no email yet claims its `plan_limit_emails` row, then writes to every Owner through the email server the alert channels use; without one it waits, and a failed send releases the claim.
  - **Retention tiers:** `VICTORIAMETRICS_URL_3D` and `VICTORIAMETRICS_URL_30D` (named after `VICTORIAMETRICS_URL`; Cloud only; both or neither). Unset, the one `VICTORIAMETRICS_URL` is used as before. `TieredVictoriaClient` extends the query client, so it still takes only a `ClusterScope`; it maps the cluster to its org (cached) and the org's retention to a tier (3 days or less: `3d`, else `30d`). Writes go to the current tier. While `now` < `retention_changed_at` + `previous_retention_days`, `query` and `queryRange` ask both tiers and merge series by their full label set: the current tier's point wins where it has a value, the old tier's fills the rest. If the old tier fails, the current tier's answer is returned (logged). Known edge: a rate over a window that spans the switch is partial in the new tier for one window (at most 5 minutes), and another replica may write to the old tier for up to the cache's 60 seconds; the merged read covers both. Tested against two real VictoriaMetrics 1.155 containers (scenario 12, `test/entitlements-tiers.test.ts`, run with `WATCHLOG_TEST_VM_3D_URL` and `_30D_URL`).
  - **Pages:** the plan strip (Dashboard.dc.html) at the foot of the sidebar from 1024 px and at the top of the overview below it; the over-limit and downgrade banners over every page; Settings › Plan & billing with the beta notice, the plan's four meters (the nodes' 95th percentile this period), the Pro card with "coming to Pro" for the Phase 6 features (ADR-173), the estimate, how nodes are counted, and invoices "available when billing starts". Starting Pro (the beta switch) and Stripe come with the billing service (slice 5). Community: none of it (no `GET /plan`, no tab).
  - **Real check:** a Cloud backend and worker on a scratch database: heartbeats for 5 nodes answered 204, the 6th and 7th 402; a second cluster 409; the internal listener 401 without the token and the public one 404; `PUT` Pro, 8 nodes, `PUT` Free: all 8 kept sending, a 9th got 402, the banner said 14 days.

## ADR-178: Billing is a separate service behind an interface, built on Stripe's test mode, live switch off

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact)
- Context: SPEC §3.3 chose Stripe (Checkout, Billing, Customer Portal, usage reported daily). Billing code stays out of this repository (SPEC §3.4). There's no payment entity yet.
- Decision:
  - **A small TypeScript service** in the private Cloud repository, with the `stripe` package, its own PostgreSQL schema `billing` and role (Stripe customer and subscription ids, processed webhook event ids, meter reports sent; never card data), and a `BillingProvider` interface so Stripe can be replaced.
  - **Prices** (SPEC §3.3, its open choice decided here): monthly Pro is a metered, graduated price: the first 10 nodes are a flat $10, then $1 per node. That is the $10 minimum with no separate fee. Annual Pro is a committed node count at $10 per node a year (2 months free), minimum 10 nodes, with nodes above the commitment billed monthly at the metered price.
  - **Usage:** once a day the service reads the org's 95th percentile so far in the period from the product's internal usage API and sends it as a meter event to a meter that aggregates with `last`. The period's last report is the period's p95. Reports are idempotent per org and day.
  - **Webhooks:** the signature is verified (`stripe.webhooks.constructEvent`, 5-minute tolerance), each event id is processed once (insert-or-skip in the same transaction as its effect), and handlers converge on Stripe's current state rather than trusting event order. They write entitlements through the product's internal API.
  - **Dunning:** Stripe's retries plus WatchLog's own emails. After 14 days unpaid, the org moves to Free (data kept, ADR-177).
  - **The live switch:** `BILLING_LIVE=false` by default. While false, the service refuses `sk_live_` and `rk_live_` keys and the product offers "Pro free during beta" instead of Checkout. With no test keys, everything runs against `stripe-mock`.
  - **The internal API** (product ↔ billing) listens only on the Compose network, authenticated by a shared `WATCHLOG_INTERNAL_TOKEN`, compared in constant time and rotatable with a previous value.
  - **Card data never reaches our servers:** Checkout and the Customer Portal are Stripe's pages.
- Alternatives: billing inside the backend (rejected: SPEC §3.4); a reseller (Paddle, Lemon Squeezy) (kept possible by the interface; the owner and a lawyer decide with the entity).
- Consequences: tests run on `stripe-mock` in CI and against Stripe's test mode when test keys exist. Switching billing on is a config change plus the 14 days' notice.
- As built (Cloud slice 5, 2026-11-13):
  - **Storage:** the service keeps its state in SQLite through Node's built-in `node:sqlite`, on its own volume, not in a PostgreSQL schema `billing`: a PostgreSQL client would have been a new dependency for the service, and the billing state is small (customer and subscription ids per org, webhook event ids, meter reports, dunning, the beta, the entitlements to push). Never card data. The Cloud kit backs it up with the rest.
  - **The service** is TypeScript on Node 24 and Fastify with one new dependency, `stripe` (exact version). `BillingProvider` has the Stripe implementation; tests run on `stripe-mock`. Its API for the product (`GET /orgs/:id`, `POST /orgs/:id/beta`, `/checkout`, `/portal`) takes the same `WATCHLOG_INTERNAL_TOKEN` (and `_PREVIOUS`) as the product's internal API, compared in constant time; `POST /webhooks/stripe` is the only path the public proxy routes.
  - **The live switch:** with `BILLING_LIVE=false` (the default) the service won't start with a `sk_live_` or `rk_live_` key and says why without printing it; Checkout answers `409 billing-not-live`; the beta's 14-day notice is built but not scheduled. With it true, the beta answers `409 billing-live`. Test keys with `BILLING_LIVE=true` are Stripe's test mode.
  - **Webhooks:** `constructEvent` with a 5-minute tolerance; the event id is inserted in the same SQLite transaction as everything the event changes, and a failure answers 500 with nothing recorded, so Stripe retries. Handlers read the subscription and invoice the event names from Stripe at that moment and never use the payload's state, so a duplicate does nothing and an older event delivered late converges on Stripe's current state (scenario 13). The entitlements each org should have are written in that transaction and pushed to the internal API after it, retried every minute until they land; the `PUT` replaces the row, so repeating it is harmless. Webhooks, jobs and the product's calls run one at a time; no transaction waits on the network.
  - **What an org gets:** Pro (`source: billing`) while a subscription is active, trialing, past due or unpaid and dunning hasn't run out; Pro (`source: beta`) during the beta; Free (`source: billing`) otherwise. A paid subscription ends the beta.
  - **Prices:** monthly is one metered, graduated price (0–10 nodes a flat $10, then $1). Annual is a licensed price, $10 per node a year, quantity the committed count (at least 10); nodes above it go on a second, monthly metered subscription the service creates after the annual Checkout with the same payment method, because one Stripe subscription bills at one interval. Both meters aggregate with `last`. Price ids and meter event names come from the environment.
  - **Meters:** hourly, at most one report per org and UTC day (a local row keyed by org and day, and the Stripe identifier `wl-<org>-<day>`): monthly sends the p95 from the period's start to now; annual sends the p95 above the commitment. Known edge: up to a day at the period's end can miss the last report.
  - **Dunning:** at `invoice.payment_failed`, if the invoice is still open when read, the org's Owners get one email per invoice. An invoice unpaid 14 days after its first failure moves the org to Free (the product's own 14-day node grace follows, ADR-177); paying later brings Pro back. The internal API gains `GET /internal/orgs/:id/owners` for these emails.
  - **The product:** `WATCHLOG_BILLING_URL` (Cloud only, needs `WATCHLOG_INTERNAL_TOKEN`). `GET /api/v1/plan/billing` gives every member the state (`available: false` when no billing service is set or it can't be reached); `POST /api/v1/plan/beta`, `/plan/checkout` (`{interval, nodes?}`) and `/plan/portal` are Owner-only, act on the session's org only, pass the billing service's refusals on with their code, and answer 503 `billing-unavailable` otherwise. Checkout and portal URLs are passed on only if they're `https://`. All are classified `cloud` in the isolation suite; Community answers 404.
  - **The page:** the Pro card has the monthly/annual toggle and its estimate (annual: $10 a node a year, at least 10, "saves" two months), "Start Pro, free during beta" while billing is off (Upgrade and Manage billing once it's live), locked with the reason for Admins and Viewers, a warning when a payment failed, and "Invoices and payment method — available when billing starts". The plan strip says "free during beta" next to the beta's Pro.

## ADR-179: Lifecycle emails, the funnel and the Cloud admin, with an audited support mode

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact)
- Context: SPEC §10.4 wants funnel events from day one and an admin page; staff sometimes need to see a customer's org to help, and customers need to know when that happened.
- Decision:
  - **Funnel events** (Cloud): `funnel_events` (org, user, event, props, time), written server-side where the event happens, plus `POST /api/v1/funnel` for the few client-side ones (an allow-listed set: `install_command_copied`, `sample_opened`, `dashboard_first_view`). SPEC §10.4's events plus `email_verified`, `second_cluster_added`, `teammate_invited`, `application_connected`, `mcp_first_call`, `pro_started`.
  - **Lifecycle emails** (Cloud): plain text from the founder's address, through the existing SMTP setup, each with a one-click unsubscribe (a signed token, `List-Unsubscribe` and `List-Unsubscribe-Post`). They are welcome; no data after 1 hour; the first alert explained; day 3 tips; near a Free limit; and the beta-to-billing notice. They are sent by a job in the alert worker, at most one lifecycle email a day per user, and recorded so none is sent twice.
  - **The Cloud admin:** the product exposes an internal admin API (orgs, usage, plans and entitlements, funnel by week, support sessions), reachable only on the Compose network with `WATCHLOG_INTERNAL_TOKEN` and the staff member's identity. The waitlist's admin panel (already behind its own sign-in with TOTP) grows into the Cloud admin and calls it.
  - **Support mode:** a staff member opens a support session for one org with a reason. It is read-only, lasts at most 1 hour, and is recorded in `support_sessions` and the org's audit events. The org's Owners see each session (who, when, why, what was opened) in Settings › Security and get an email when one starts. API and cluster tokens record "accessed by WatchLog staff" when read in support mode.
- Alternatives: a third-party product-analytics tool (rejected: sends user data to another processor); staff signing in as the user (rejected: no audit trail, and it can write).
- Consequences: the waitlist admin panel and the Cloud admin share one sign-in. Subprocessors stay minimal (Stripe, Cloudflare, the email provider, the backup storage).
- As built (Cloud slice 6a, 2026-11-13; the funnel, the lifecycle emails, the internal admin API and support mode; the Cloud admin's pages are slice 6c):
  - **Funnel:** `funnel_events` (migration `1795100000000_cloud-funnel-support`, RLS) with `once_key`: `''` once per org, `user:<id>` once per user, `cluster:<id>` once per cluster, NULL for events that repeat; a partial unique index on `(org_id, name, once_key)` is the rule (insert, `ON CONFLICT DO NOTHING`), across processes and replicas. `FunnelRecorder` writes each event inside `withOrg` on the request path's pool, so RLS holds for it; it keeps a set of one-time events it already wrote only to keep ingest's hot path from asking again. Recording never fails a request, and nothing is recorded in support mode. Where each fires: `signup_completed`, `email_verified` (accounts), `cluster_created` and `second_cluster_added` (`POST /clusters`), `agent_first_heartbeat` and `first_metrics_received` (ingest's heartbeat and remote write, once per cluster; the checklist's in-memory version is gone), `alert_channel_connected` (a channel made, a test sent, a Telegram chat connected in the worker), `first_alert_sent` (the worker's delivery, the first notification sent), `teammate_invited`, `application_connected`, `mcp_first_call` (the MCP server), `pro_started` (the beta button, and the first `PUT` with Pro from billing or staff), `day7_active` (a daily worker task: first heartbeat 7 or more days ago and one in the last day, once per cluster). `POST /api/v1/funnel` keeps an allow-list: `install_command_copied`, `sample_opened`, `dashboard_first_view` (the overview with data), and the wizard's `onboarding_dashboard_opened`, `onboarding_help_opened`, `onboarding_troubleshooting_shown`; `onboarding_sample_opened` became `sample_opened` (never released).
  - **Lifecycle emails:** a worker task every 10 minutes (`modules/lifecycle/job.ts`): Owners listed across orgs on `systemDb`, each email's record (`lifecycle_emails`, key user and kind) claimed inside `withOrg` before sending and released if the send fails. Sender and Reply-To `WATCHLOG_LIFECYCLE_FROM` (unset: none sent), through the email server the alert channels use. **Who:** Owners with a verified address (an unverified one could be anyone's), accounts under 30 days old, about their first org; never after an unsubscribe. **When, one at most a day:** welcome (first 2 days), the first alert explained (within 3 days of the org's first notification), no data after an hour (first week, linking the install page, which shows the checks after 2 minutes), near the Free node limit (one node from it), the day-3 tips (days 3 to 10, with data). Subjects: "Welcome to WatchLog", "Need help installing WatchLog?", "Your first WatchLog alert, explained", "Three things to try in WatchLog", "<org> is close to the Free node limit", "WatchLog Pro: billing starts in 14 days". **The beta notice** is sent only when billing asks (`POST /internal/orgs/:id/beta-notice {billingStartsAt}` → `beta_notices`), to every Owner of an org still on the beta, once; it is a service notice, so neither the daily limit nor the unsubscribe applies and it has no unsubscribe link. The billing service's own `sendBetaNotices` (slice 5) must call this route instead of mailing, so only one goes out (left for slice 7; both are off until `BILLING_LIVE=true`). **Unsubscribe:** `<public URL>/api/v1/email/unsubscribe?token=<user id>.<HMAC-SHA-256, 18 bytes, key HKDF'd from WATCHLOG_SECRET_KEY>`, in the text and in `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). GET shows one button (link scanners change nothing); POST, from that button or a mail client, sets `users.lifecycle_unsubscribed_at`. A rotated secret key turns old links into "this link does not work" (reply to unsubscribe).
  - **The internal admin API** is on slice 4's internal listener (`modules/internal/admin.ts`): every `/internal/admin/*` request needs the internal token **and** `X-WatchLog-Staff: <email>` (400 without a valid address). The Cloud admin sets that header from its own signed-in admin (its TOTP sign-in), never from user input; the product trusts it because only a holder of the internal token on the Compose network can send it. The address is written into every staff write's audit event (`actor_name` "WatchLog staff (<email>)", `actor_id` null) and every support session. Reads: orgs (search by name, slug, member email or id; status filter; plan, source, status, created, clusters, members, nodes now = node and Docker agents seen in 3 minutes, last data), one org (row, entitlements, members with emails, verified, 2FA and last activity, clusters), members, usage (default the last 30 days), entitlements, and the funnel by signup week (orgs whose first `signup_completed` fell in the week, how many reached each step since, and the conversion from the step before). Writes: entitlements with `source: staff` (any other `source` in the body is dropped), suspend and unsuspend with a reason. Each write is in the org's audit events (`staff_entitlements_set`, `staff_org_suspended`, `staff_org_unsuspended`). **Suspended** (`orgs.suspended_at`): ingest answers 402 `urn:watchlog:problem:org-suspended` (cached like the entitlements, 60 s on other replicas); sign-in and reads still work; slice 6b's inactive-org suspension uses the same column.
  - **Support mode, the mechanism:** `POST /internal/admin/orgs/:id/support-sessions {reason, minutes ≤ 60}` writes `support_sessions` (staff email, reason, `expires_at` ≤ start + 1 hour, also a database CHECK), the audit event, and emails the Owners; it answers a one-time link `<public URL>/api/v1/support/enter?code=wl_sc_…` (256 bits, SHA-256 at rest, 2 minutes, one use; the request log masks `code=`). The Cloud admin opens it in a browser: the backend trades the code for a `wl_support` cookie (HttpOnly, Secure, SameSite=Strict, until the session ends; its value stored as SHA-256) and redirects to `/`. No user, password or session of the customer's is involved, and the staff member's own session in the same browser is ignored while the cookie is there. **Why it can't write, three layers:** (1) a hook refuses every request that isn't GET/HEAD/OPTIONS with 403 `support-read-only`, before authentication runs, except the chart queries POSTed for their body and `DELETE /api/v1/support/session` (leave); GETs with side effects are refused too (the demo's list, container logs, the account's own pages); (2) the support user is a viewer of that one org, so every role guard refuses changes; (3) the request's database scope is read-only: the org-scoped pool sets `default_transaction_read_only = on` with the org on each checkout for that request (one round trip, reset to off for every other checkout), so PostgreSQL refuses any INSERT, UPDATE or DELETE such a request tries, even through a guard nobody wrote. The isolation suite calls every route with a support cookie: each change is 403 with either org's ids and neither org's rows change; each read with the other org's ids is 404 or 403; each of its own reads answers without a 5xx (which caught three GETs that wrote: the alert rules' defaults and the first-week card now skip their write in a read-only scope; logs are refused). **What it records** (on the owner's connection, since the request itself can't write): each API path it opened, once with a count (the requests every page makes on load are left out), shown to the Owners; tokens read: a cluster's page (its token prefixes) and the Users page or a token's page (the org's API tokens) add `support_tokens_accessed` to the audit events and a `staff_access` event to each API token's history ("Accessed by WatchLog staff in a support session"). **Ends** at its hour, when staff leave (`DELETE /api/v1/support/session`, also the sidebar's Sign out) or by `DELETE /internal/admin/support-sessions/:id`; each end is audited.
  - **Owners' view:** `GET /api/v1/support-sessions` (Owners) and Settings › Security's "WatchLog staff access": who, when, why, state (in progress, ended, link not used) and what it opened. The dashboard shows a banner over every page while in support mode (`GET /api/v1/support/current`): whose org, who, why, until when, "nothing can be changed", and "Leave support mode"; the first-week card is hidden and nothing reaches the funnel.

## ADR-180: Cloud runs on the current production server, as its own Compose project behind the host's nginx

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact; replaces SPEC §5.5's Caddy layout)
- Context: the owner decided Cloud starts on the current server (36 GB), which already runs the v1 app, the site and the waitlist, and the live demo. The host's nginx already owns ports 80 and 443.
- Decision:
  - **Its own Compose project**, network and volumes, under its own data directory: backend, alert worker, web, `vm-3d`, `vm-30d`, PostgreSQL 16, Redis and billing, from the public release's images plus the private billing image. Ports publish on 127.0.0.1 only; no other project's container can reach Cloud's PostgreSQL, Redis or VictoriaMetrics.
  - **Limits on every container** (memory and CPU), set from measurements in slice 7 and checked in its test. The demo keeps its caps, so a demo OOM scenario can't starve Cloud.
  - **The host's nginx:** new vhost files for `cloud.watchlog.io` (the dashboard and API) and `ingest.watchlog.io` (agents only: `/ingest/` and nothing else, body limits as ADR-027, the query string kept out of the access log). The owner installs them with sudo, with certificates from the setup the site already uses, behind Cloudflare. No Caddy.
  - **status.watchlog.io** is an external uptime service's status page (a DNS record the owner adds, no vhost), so it stays up when the server doesn't.
  - **Backups:** nightly `pg_dump`, WAL archiving and VictoriaMetrics snapshots, encrypted on the server before they leave it (OpenSSL in the PostgreSQL image: AES-256-CBC with PBKDF2, then HMAC-SHA256 over the ciphertext, keys only in the server's env file), uploaded to S3-compatible storage with `curl --aws-sigv4`. A restore-test script runs monthly into a scratch Compose project and checks row counts and a metric.
  - **Monitoring:** a WatchLog Docker agent on the server reports the Cloud project's containers to a staff org in Cloud itself, with the external uptime check for when Cloud is down.
  - **The demo's privileged Docker host** (ADR-170) is the main risk on a box with customer data. Before the first customers are invited, the owner either turns it off (`DEMO_DOCKER=off`) or moves the demo to another server.
  - **Tested** in a Lima VM that runs the server kit, the demo kit and the Cloud kit together, like the server kit's `server-test.sh`. Nothing existing on the server is touched; everything that needs sudo is in the owner's command list.
- Alternatives: a new server (rejected by the owner for now: no extra cost until there are customers); Caddy as in SPEC §5.5 (rejected: the host's nginx owns 80 and 443).
- Consequences: SPEC §5.5 is rewritten. A later move to its own server is a copy of the data directory and a DNS change.

## ADR-181: The Cloud security baseline

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact; closes ADR-091 item 2 for Cloud)
- Context: SPEC §14 asks for OWASP ASVS L1. A hosted service that holds many teams' cluster data needs more, checked by someone who didn't write it.
- Decision:
  - **SSRF egress policy** (Cloud): webhook, Slack and other channel URLs, and every server-side fetch to a user-given address, resolve the host and refuse loopback, private, link-local, CGNAT, multicast and metadata addresses (IPv4 and IPv6, IPv4-mapped included). The check runs at save time and again at send time, on the address actually connected to (no DNS rebinding), and doesn't follow redirects. Community keeps any `http(s)` URL (ADR-091), since self-hosters post to their own networks.
  - **Headers** (Cloud): a strict Content-Security-Policy for the dashboard (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), HSTS at the nginx vhost, `Referrer-Policy: strict-origin-when-cross-origin`, and `Secure` cookies always. CSRF is as ADR-034.
  - **Tokens:** cluster, API and install tokens are scoped to one org and hashed (ADR-025, ADR-125); secrets at rest are AES-256-GCM (ADR-079, ADR-133), and the key rotation is documented and tested.
  - **Data rights:** an Owner can export the org (its configuration as JSON, and a metrics range per cluster through VictoriaMetrics' export, scoped by `cluster_id`) and delete it. Deletion has a 7-day undo; then a job deletes its PostgreSQL rows and its series in both tiers (`delete_series` by `cluster_id`) and records the deletion.
  - **Inactive orgs:** a Free org with no data for 30 days is warned by email, then suspended after 7 more (ingest 402, sign-in still works to export or delete).
  - **Review:** before the first invite wave, a separate review pass that didn't write the code checks against OWASP ASVS L2 and this list; findings are fixed or recorded. A paid pen test follows once there is revenue.
- Consequences: SPEC §14's security line reads ASVS L2 for Cloud. The isolation suite (ADR-182) is the release gate.
- As built (Cloud slice 6b, 2026-11-14; the SSRF egress policy, the headers, export and deletion, inactive orgs; the review is slice 9):
  - **Egress policy** (`backend/src/lib/egress.ts`, Cloud only; Community has no policy, ADR-091 item 2 unchanged). A URL is refused unless it is `http(s)` and its host is, or resolves to, only public addresses: every address a name resolves to must pass (one private answer refuses it), and a name that doesn't resolve is refused at save time (it can't be checked). Refused ranges, IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4` (with `255.255.255.255`), the metadata addresses `169.254.169.254`, `100.100.100.200`, `192.0.0.192` named as such; IPv6: `::`, `::1`, IPv4-mapped and -translated (`::ffff:…`, the IPv4 decides), IPv4-compatible `::/96`, NAT64 `64:ff9b::/96` (the IPv4 decides) and `64:ff9b:1::/48`, 6to4 `2002::/16` (the IPv4 decides), `fd00:ec2::254`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`, `3fff::/20`, `100::/64`, `2001::/23`, and anything outside `2000::/3`. The URL parser normalises `2130706433` or `0x7f.1` to `127.0.0.1` before the check.
  - **Where it runs:** at save, `POST` and `PATCH /alert-channels` for Slack's webhook URL and a webhook's URL answer `400` `urn:watchlog:problem:egress-refused` with a plain sentence ("WatchLog Cloud doesn't send to internal addresses: 169.254.169.254 is a metadata address. Use a public URL."), and nothing is saved. At send (the worker's deliveries and the dashboard's "Send test"), `HttpClient.post(…, { userUrl: true })` checks the URL again and connects through an undici `Agent` whose `connect.lookup` resolves with the same resolver and hands the socket only addresses that passed: the address connected to is a checked one, so a DNS answer that changes between save and send (rebinding) is refused, not followed. A refusal at send is a permanent delivery error (no retries), shown as the channel's last error. Redirects are an error (`redirect: 'error'`), never followed. In Cloud these requests skip `HTTP(S)_PROXY`: a proxy would resolve the name again, out of reach of the check.
  - **Every server-side fetch, classified** (searched: `fetch`, undici, `http(s).request`, `net`/`tls` connect, nodemailer): Slack and webhook URLs are users' → the policy. Telegram: the API URL is the operator's (`WATCHLOG_TELEGRAM_API_URL`), the bot token matches `^[0-9]+:[A-Za-z0-9_-]+$` so it can't change the host; the Telegram proxy and the SMTP server from Settings are ignored in Cloud (their routes already 404 there; `SettingsService.alerting()` now reads only the environment in Cloud). Applications' connection tests run in the collectors inside the customer's cluster, never from the backend. OAuth, Turnstile, Have I Been Pwned, the billing service and VictoriaMetrics are fixed or the operator's addresses. A later fetch to a user's address must pass `userUrl: true` (or use `EgressPolicy` itself).
  - **Tests:** `test/egress.test.ts` (59: the classes table, names and mixed answers, the lookup, real sockets: pinned to the checked address, rebinding refused with nothing reaching the server, no redirect, an IP literal stored earlier, Community unchanged; scenario 15 through the API with a test resolver: metadata, a name resolving to 10.0.0.1, `[::1]`, Slack, PATCH, nothing saved, refused at send). The isolation suite's Cloud app gets a test resolver (no real DNS in CI).
  - **Bug found while measuring:** the first version's save-time helper returned the Fastify reply from an async function; a reply is thenable, so the route got `undefined`, went on and saved the channel after the `400` (and logged "Reply was already sent"). Caught on the real stack by the screenshot run; fixed, and the test now checks nothing is saved.
  - **Headers, where:** both, with one policy (`backend/src/lib/csp.ts`). The dashboard's files come from the web image, so its Caddyfile imports a per-edition snippet: `WATCHLOG_EDITION=cloud` on the web container adds the headers to the SPA's files; unset (Community), the snippet is empty and nothing changes. The backend registers helmet with the same policy in Cloud (`CLOUD_HELMET`) for the API and the one HTML page it serves (the unsubscribe page); Community keeps helmet's defaults as 0.5.0. `test/headers.test.ts` checks the Caddyfile's policy is the backend's, the API's headers in both editions, and the Secure cookie.
  - **The policy, measured** by loading 28 pages in Chrome with it on (every dashboard page for a Kubernetes cluster and a Docker fleet, every Settings tab, onboarding, the signed-out pages, chart tooltips hovered) and reading the console: `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. No inline or eval'd script (vue-i18n needs none). Two findings: the build inlines a small font as a `data:` URI (`font-src data:`), and ECharts' tooltips write inline `style` attributes (`style-src-attr 'unsafe-inline'`: attributes only, never a `<style>` element; the unsubscribe page uses them too). Turnstile renders and issues a token under it. Also `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. **HSTS** is the nginx vhost's (slice 7), so the backend doesn't send it in Cloud (one header per host).
  - **Secure cookies:** `loadConfig` already refused anything but `WATCHLOG_COOKIE_SECURE=always` in Cloud; the app now forces it too (a Cloud configuration built another way, as in tests, sent `wl_session` without Secure).
  - **Export** (Owners, Cloud): `GET /api/v1/org/export` is the configuration as JSON (`format: watchlog-org-export/1`): the org, plan and limits, members (email, name, role), clusters with token prefixes, alert rules, channels with only their visible settings (recipients, a webhook's URL, bot and chat names; never a Slack URL, bot token or signing secret), silences, applications (never credentials), API tokens (name, prefix, scope, owner), discovery choices; every read under the org (RLS). `GET /api/v1/clusters/:id/export?from=&to=` (unix seconds; default the last 24 hours, at most 31 days) streams VictoriaMetrics' `/api/v1/export` JSON lines for the cluster, through `clusterForOrg` and the `ClusterScope` (`extra_label` and a `cluster_id` matcher), from both tiers when they're set (the 30-day one's lines first). Rate limits per org, in memory like the others (one replica): 10 configuration and 30 metrics exports an hour (`429` with `retry-after`). Each is audited (`org_exported`, `{what: configuration|metrics, clusterId, from, to}`).
  - **Deletion:** `POST /api/v1/org/deletion {confirm: <the org's name>}` (Owners; a wrong name `400 confirm-mismatch`; `409` when already asked) sets `orgs.deletion_requested_at`, `deletion_due_at` (+7 days), `deletion_requested_by`, audits `org_deletion_requested`, and emails the org's verified Owners ("<org> will be deleted on <day>", undo link). From then ingest answers `402 urn:watchlog:problem:org-deleting` (the entitlements cache, invalidated in that process; 60 s elsewhere); reads, exports and sign-in still work. `DELETE /api/v1/org/deletion` (Owners) undoes it (`org_deletion_cancelled`). The worker's `data-rights` task (hourly) takes each org past its day: locks its row (an undo waits, or finds it gone), deletes each cluster's series in both tiers (`/api/v1/series` counted, then `/api/v1/admin/tsdb/delete_series` with the cluster's matcher), copies its cluster token hashes into `retired_cluster_tokens` (as a cluster's deletion does, ADR-069), deletes the org row (every tenant table cascades from `orgs`; measured on the schema), deletes the accounts that belonged to no other org (members of other orgs keep theirs), and writes `org_deletions` (`deleted_org_id`, name, requested at and by, deleted at, cluster ids, accounts deleted, series per tier). That table has no foreign keys so it outlives the org, isn't tenant data (listed in the isolation suite's global tables) and has Row-Level Security on without a policy, so the request path's role sees none of it. Ingest for an org whose row is gone answers 402 too (a token still cached elsewhere for up to 60 s), then 401.
  - **Inactive Free orgs:** the same hourly task. A Free org (no entitlements row counts as Free), not suspended and not being deleted, with no heartbeat for 30 days (counted from the last heartbeat, its creation, or a lifted suspension, whichever is last) is warned once: `orgs.inactive_warned_at`, audit `org_inactive_warned`, an email to its verified Owners, and the dashboard's banner with the day. Seven days after the warning, still without data, it is suspended: `suspended_at`, `suspension_kind = 'inactive'`, `suspended_reason` "No data for N days", audit `org_inactive_suspended`, a second email; ingest `402 org-suspended` as for staff's suspensions (ADR-179). Data after the warning, or a plan other than Free, clears the warning. **Reactivating:** `POST /api/v1/org/reactivate` (Owners) lifts only an inactivity suspension (`409` for staff's) and restarts the count (`orgs.inactivity_reset_at`, `org_reactivated`); staff's unsuspend restarts it too, and staff's suspend now records `suspension_kind = 'staff'`. The emails are service notices (no unsubscribe), from `WATCHLOG_LIFECYCLE_FROM` or the email server's sender; without an email server the state still changes and the banner says it.
  - **The dashboard:** `GET /api/v1/org/status` (any member) feeds a banner over every page (with the plan's, refreshed every minute): deletion (the day; Undo for Owners, "An Owner can undo it" for others), the inactivity warning (the day), the inactivity suspension (Reactivate for Owners), staff's suspension (its reason). Settings › Data (Cloud) has the two downloads (plain links: the session cookie goes along) and the deletion with its typed confirmation, then the day and Undo.
  - **Migration** `1795200000000_cloud-data-rights` (orgs columns, `org_deletions`, the audit actions). **Isolation:** 6 routes classified `cloud`; a new test calls the metrics export as B with both of A's cluster ids (404, nothing of A), B's own exports (nothing of A), and A's control; the support sweep passes (exports are Owner-only, so a support session gets 403 before any write). Tests: `test/data-rights.test.ts` (6: exports, scenario 17, inactivity, Pro never warned, both tiers on two real VictoriaMetrics), `test/headers.test.ts` (5), web `cloud-data-rights.test.ts` (9).

## ADR-182: The cross-org isolation suite is the release gate

- Date: 2026-11-13 · Status: accepted (Cloud slice 0; pre-approved, reviewed after the fact)
- Context: one leak between orgs would end the product's credibility. Routes grow every release.
- Decision:
  - **Two orgs,** each with a Kubernetes cluster and a Docker fleet with objects, metrics, alerts, channels, applications, tokens and users, seeded directly (no agents needed), against real PostgreSQL and VictoriaMetrics.
  - **Everything is enumerated, not listed by hand:** every REST route from Fastify's route table, every MCP tool from the MCP server, every curated query key from the catalog, every ingest path and every SSE stream. Each is called as org B with org A's ids, and must answer 404 (or 403 where the role decides first) or an empty answer. Ingest with org B's token never lands in org A's cluster. A new route, tool, key or stream without a classification fails the suite.
  - **Two layers tested separately:** the routes under `watchlog_app` with RLS (the product as it runs), and a direct check that every tenant table has RLS on and that a query with no org setting returns no rows.
  - **Where it runs:** in CI on every push, as its own job, and in every Cloud slice's fast checks. It must stay under 5 minutes. A failing isolation test is fixed before anything else.
- Consequences: each slice adds its new routes to the classification. Community runs the same suite's route table to prove the Cloud routes answer 404 there.
- As built (Cloud slice 1, 2026-11-13):
  - **Where:** `backend/test/isolation/`: `cloud.ts` (the Cloud app as `watchlog_app`, the two orgs), `classification.ts` (every route's kind: `org`, `public`, `installation`, `stream`, `ingest`, `mcp`, `cloud`), `cross-org.test.ts`, `community.test.ts`, `guards.test.ts`, `tables.ts` (the global tables). It also runs in `pnpm test`, and as the CI job "Cross-org isolation (Cloud)".
  - **Seeded** through the API and ingest with each cluster's token, as agents send it (the kind fixture; org B's with its own uids), plus the rows only the worker or a collector writes (an alert, a notification, a silence, a service, a probe, a discovery ignore) as the owner. A's data carries the marker `zzalpha` or is one of A's ids; B's carries `zzbeta`.
  - **Coverage:** 116 routes from Fastify's route table (an unclassified or vanished route fails); every read called as B with A's ids (404 or 403), as B with B's own ids (nothing of A, so metrics' `extra_label` is covered too), and as A with the same ids (it must succeed: 23 controls prove the ids are A's real ones; 3 routes are exempt with a reason); every change as B with A's ids (404 or 403), then a fingerprint of all of A's rows in every tenant table must be unchanged; 16 MCP tools with Kubernetes and Docker ids, as B and as A; 117 curated query keys on both of A's clusters (404) and B's own two (nothing of A); 2 log streams; 9 ingest paths (401 without a token, nothing of A's changed or shown with B's), a write naming `cluster_id` or `tenant_id` refused with 400, and B's write landing in B's cluster only; RLS on with the policy for 27 tenant tables, `orgs` and the partitions, no row without an org setting, none of A's with B's, A's rows neither updatable nor insertable with B's, and a row of B's naming A's cluster refused by the composite key.
  - **An answer "leaks" when it contains a marker of A that the request didn't send:** a 404 echoes the URL in `instance`, which reveals nothing. Generated request bodies use a neutral word, not either org's marker.
  - **It catches what it should:** with `clusterForOrg`'s org filter removed, it still passes (RLS holds alone); with the filter removed and the app connected as the owner, four of its tests fail: the reads, the changes, the streams and the query keys.
  - **Time:** about 26 s locally against the e2e PostgreSQL and VictoriaMetrics.
  - **No leak found.** One Cloud-only hole closed while building it: the installation's settings routes, which an org's Owner could have used to change what every org shares (ADR-174's As built).
