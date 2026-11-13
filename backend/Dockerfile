# SPDX-License-Identifier: AGPL-3.0-only
# Build context: repository root.
# RUNTIME_IMAGE is overridable for networks that cannot reach gcr.io (see Makefile).
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian12:nonroot

FROM node:24-bookworm-slim AS build
ARG RUNTIME_IMAGE
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json backend/
COPY packages/cause-words/package.json packages/cause-words/
RUN pnpm install --frozen-lockfile --filter @watchlog/backend...
# The words the notifications share with the dashboard (ADR-157): plain JavaScript.
COPY packages/cause-words packages/cause-words
COPY backend backend
RUN pnpm --filter @watchlog/backend build \
 && pnpm --filter @watchlog/backend deploy --prod /out \
 && cp -r backend/dist /out/dist
# `watchlog`, the command for operators (ADR-140: `watchlog admin reset-password`). The
# runtime has no shell, so it is a node script; its first line names node's path in the
# runtime image (distroless keeps it in /nodejs/bin).
RUN case "$RUNTIME_IMAGE" in *distroless*) node=/nodejs/bin/node ;; *) node=/usr/local/bin/node ;; esac \
 && printf '#!%s\nprocess.env.WATCHLOG_CLI = "1";\nimport("/app/dist/cli.js");\n' "$node" > /out/watchlog \
 && chmod 0755 /out/watchlog

FROM ${RUNTIME_IMAGE}
ARG VERSION=dev
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /repo/backend/migrations ./migrations
# The kubectl manifest Cloud serves at /install.yaml (scripts/render-install-manifest.sh).
COPY --from=build /repo/backend/assets ./assets
COPY --from=build /out/watchlog /usr/local/bin/watchlog
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4080 WATCHLOG_VERSION=${VERSION}
# `node` on PATH in both runtime images (distroless keeps it in /nodejs/bin), so the
# Compose healthcheck of the alert-worker can call it without a shell.
ENV PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin
# Default command serves the API; run `dist/migrate.js` as a one-shot container to migrate.
USER 65532:65532
EXPOSE 4080
CMD ["dist/server.js"]
