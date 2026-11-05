# SPDX-License-Identifier: AGPL-3.0-only
# Build context: repository root.
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY web/package.json web/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/api-types/package.json packages/api-types/
RUN pnpm install --frozen-lockfile --filter @watchlog/web...
COPY packages/design-tokens packages/design-tokens
COPY packages/api-types packages/api-types
COPY web web
RUN pnpm --filter @watchlog/web build

FROM caddy:2-alpine
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/web/dist /srv
ENV XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
USER 65532:65532
EXPOSE 8080
