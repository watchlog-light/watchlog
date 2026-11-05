# Contributing to WatchLog

Thanks for helping. Bug reports, fixes, docs and new collectors are all welcome.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue first if you're unsure.
- **Features:** open an issue to agree on the approach first. [docs/SPEC.md](docs/SPEC.md) describes the product and [docs/DECISIONS.md](docs/DECISIONS.md) the decisions behind it. A change that goes against an accepted decision needs a new decision record, not just code.
- **Security issues:** don't open an issue. See [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement

Before your first pull request is merged, you sign the [CLA](CLA.md) once: the CLA Assistant bot asks in the pull request, and you sign by replying with a comment. You keep the copyright of your contribution. The CLA lets the project offer WatchLog under AGPL-3.0 and, for `ee/`, under a commercial licence ([docs/SPEC.md §3.4](docs/SPEC.md)).

The WatchLog name and logo aren't part of the licence. If you publish a fork, give it its own name and logo; see [TRADEMARKS.md](TRADEMARKS.md).

## Development setup

Prerequisites: Node.js 24 (`.nvmrc`), corepack (`corepack enable`), Go 1.27, Docker and GNU Make.

```bash
pnpm i            # JS dependencies
pnpm infra:up     # PostgreSQL, VictoriaMetrics, Redis in Docker
pnpm dev          # backend on :4080, dashboard on http://localhost:4088
make agent        # the Go agent in bin/
```

The [README](README.md#development) has the details, including a Kubernetes test cluster with kind. If `proxy.golang.org` is blocked on your network, build with `GOPROXY=https://goproxy.io,direct`.

## Making a change

- **Tests:** add or update tests with the change.
  - **Agent:** unit tests per collector, with fixtures captured from real systems (`/proc`, cgroups, API responses). Never infer a data shape from code alone. Add a benchmark when you touch a collector.
  - **Backend:** Vitest against the real PostgreSQL and VictoriaMetrics from `pnpm infra:up`.
  - **Web:** Vitest component tests.
- **Budgets:** the agent stays within 64 MB of memory and 1 % of a core, and its images within 40 MB. CI checks the image sizes.
- **Security:** the agent never reads Secrets, ConfigMap data, environment values or request payloads. A change to what the agent can access updates [docs/security.md](docs/security.md) in the same pull request.
- **UI:**
  - Colours come only from the design tokens (`packages/design-tokens/tokens.css`); a test fails on colour literals in `web/src`.
  - Every user-visible string goes through i18n (`web/src/i18n/en.json`).
  - Reuse the existing components: loading skeletons, empty and error states.
- **Upgrades never need manual steps.** If a change needs one, ship an automatic migration instead. New Helm values must be read safely when an older release's values are reused (`deploy/test/helm/upgrade-test.sh`).
- **Licence headers:** every source file starts with `SPDX-License-Identifier: AGPL-3.0-only` (`LicenseRef-WatchLog-Enterprise` in `ee/`).

## Commits and pull requests

- [Conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`, `perf:`. Release notes are built from them.
- Keep UI changes and backend or agent changes in separate commits, so each can be reverted alone.
- Before pushing:

  ```bash
  pnpm lint && pnpm test && pnpm format:check && pnpm check:license && pnpm check:private
  make agent-lint agent-test
  ```

- **Nothing private:** the maintainers keep internal notes and Cloud-only code in separate private repositories. CI fails if this repository tracks their folders, local settings (`.env`) or databases, or if a file names those repositories or contains a personal email address or home path (`pnpm check:private`). To run the same check before every commit:

  ```bash
  git config core.hooksPath .githooks
  ```

- Fill in the pull request template. CI must be green before review.

## Getting help

Ask in [GitHub Discussions](https://github.com/watchlog-light/watchlog/discussions), or in an issue if you've found a bug.
