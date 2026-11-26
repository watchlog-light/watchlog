# The own-metrics push step test

Does the backend stay up, and does it keep taking the agents' data, when pushes of own metrics
are raised far past what it can serve? (1.0.3, ADR-242.)

Pushes are raised in steps (50, 200, 500, 1,000 and 2,000 a second) across many own-metrics
tokens of many organisations, while one agent per organisation writes and heartbeats every
five seconds beside them. The backend runs in a container sized like Cloud's (2 CPUs, 1 GiB),
in Cloud mode, on one Docker network with its PostgreSQL and VictoriaMetrics. For each step the
generator records the pushes accepted and refused by answer (`429` a rate limit, `503` set
aside under pressure), the p95 latency of a push and of an agent's call, the container's CPU
and memory from its own counters, and afterwards whether every agent write that was
acknowledged is in VictoriaMetrics.

**The run passes** when no agent call is refused at any step, no acknowledged agent write is
missing, and the backend never restarts or runs out of memory, however many pushes are refused.

It holds at most ten minutes of steady load and needs nothing but Docker, Node and a throwaway
PostgreSQL and VictoriaMetrics. Not part of CI.

```bash
# 1. The image under test, a network, the stores (names and ports are yours to choose).
make image-backend BACKEND_RUNTIME_IMAGE=node:24-bookworm-slim IMAGE_TAG=load
docker network create load-net
docker run -d --name load-pg --network load-net -p 127.0.0.1:54398:5432 \
  -e POSTGRES_USER=watchlog -e POSTGRES_PASSWORD=watchlog -e POSTGRES_DB=load postgres:16-alpine
docker run -d --name load-vm --network load-net -p 127.0.0.1:8496:8428 \
  victoriametrics/victoria-metrics:v1.155.0

# 2. The schema and the request path's role (Cloud runs under Row-Level Security).
OWNER=postgres://watchlog:watchlog@127.0.0.1:54398/load
(cd backend && DATABASE_URL=$OWNER pnpm migrate &&
  pnpm exec tsx scripts/own-push-load-seed.ts role $OWNER load_app load_app_local)

# 3. The backend, sized like Cloud's.
docker run -d --name load-backend --network load-net --cpus 2 --memory 1g \
  -p 127.0.0.1:4380:4080 -e WATCHLOG_EDITION=cloud -e HOST=0.0.0.0 -e PORT=4080 \
  -e DATABASE_URL=postgres://load_app:load_app_local@load-pg:5432/load \
  -e DATABASE_SYSTEM_URL=postgres://watchlog:watchlog@load-pg:5432/load \
  -e VICTORIAMETRICS_URL=http://load-vm:8428 -e WATCHLOG_PUBLIC_URL=https://load.example \
  -e WATCHLOG_SECRET_KEY="$(openssl rand -base64 32)" ghcr.io/watchlog-light/backend:load

# 4. 40 organisations on Pro, each with a fleet and 5 own-metrics tokens.
(cd backend && pnpm exec tsx scripts/own-push-load-seed.ts orgs $OWNER \
  http://127.0.0.1:4380 40 5 /tmp/own-push-state.json)

# 5. The steps; a table at the end, and the same as JSON.
node deploy/test/own-push-load/run.mjs --ingest http://127.0.0.1:4380 \
  --state /tmp/own-push-state.json --vm http://127.0.0.1:8496 --container load-backend \
  --steps 50,200,500,1000,2000 --step-seconds 100 --out /tmp/own-push-result.json

# 6. Away with it.
docker rm -f -v load-backend load-vm load-pg && docker network rm load-net
```

With 40 organisations and 200 tokens, 2,000 pushes a second are 10 a second for each token and
50 for each organisation: under both rate limits (100 and 300), so what is refused is refused
by the installation's own pressure, which is what the test is about. Fewer tokens show the rate
limits instead.

Keep the stores on the backend's own network. Reached through the host's port forwarding, each
write to VictoriaMetrics takes far longer than it does in production, and the backend sets
pushes aside at a few hundred a second for that reason alone.
