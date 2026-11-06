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

- Date: 2026-10-31 · Status: accepted
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
  - A new Service's edges appear correct from their first drain. `deploy/test/k8s/servicemap-latency.py` measures the delay from Service creation to a correct edge.
  - The cluster-agent keeps one encoded map, rebuilt at most once a second during churn. Each node agent holds one idle HTTPS request.
  - A Service with no endpoints and no matching pods or workloads is still drawn as a Service.

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
