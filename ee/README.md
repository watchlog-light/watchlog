# ee/ — WatchLog Enterprise

Enterprise-only modules (SPEC §3.4, ADR-232). Code here is **not** AGPL-3.0: it is under
the WatchLog Enterprise licence in [LICENSE](LICENSE), and its files start with
`SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise` (ADR-015). Everything outside
`ee/` is AGPL-3.0-only.

The core builds and runs with `ee/` deleted (CI's "core without ee" job checks it), and each
module works only with a valid licence key that lists its feature.

| Folder       | What                                                                                                                    | How the core finds it                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`   | TypeScript modules (`modules` from `src/index.ts`), each registering its routes behind `host.requireFeature(<feature>)` | `backend/src/ee.ts` imports the entry if it exists; the types are `backend/src/ee-contract.d.ts`. Built by `pnpm ee:build` and in the backend image |
| `web/`       | Vue pages and sidebar items (`<module>/index.ts` exporting `eeWebModule`)                                               | `web/src/ee/index.ts`, `import.meta.glob` (nothing when the folder is missing)                                                                      |
| `collector/` | Go packages built into the integrations collector (its own Go module)                                                   | the `ee` build tag and a generated `go.work` (`scripts/ee-go.sh`); without the tag the collector builds as before                                   |

Each folder holds a small placeholder module (feature `network`) that proves the wiring. It
goes when the network module arrives.
