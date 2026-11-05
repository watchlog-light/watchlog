# ee/ — WatchLog Enterprise

This directory will contain Enterprise-only modules (SSO, LDAP, fine-grained RBAC, audit log, offline license keys, advanced anomaly correlation; SPEC §3.2, Phase 7).

- Code here is **not** AGPL-3.0. It is licensed under the WatchLog Enterprise commercial source-available license (to be added with the first module). Source files use `SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise` (ADR-015).
- The core MUST build and run with `ee/` deleted. Enterprise modules are loaded only when a valid license key is present (SPEC §3.4).
- Everything outside `ee/` is AGPL-3.0-only (see the root `LICENSE`).
