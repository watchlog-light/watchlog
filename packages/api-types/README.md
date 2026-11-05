# @watchlog/api-types

TypeScript types for the WatchLog REST API, consumed by `web/`. Generated from the backend's OpenAPI document:

```bash
pnpm api-types:generate   # writes openapi.json and src/generated/openapi.ts
```

`src/index.ts` exports named aliases (`CurrentUser`, `LoginRequest`, …). CI fails if the generated files are out of date.
