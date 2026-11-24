// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Every Enterprise backend module (ADR-232); the core's backend/src/ee.ts registers them.
import type { EeBackendModule } from '../../../backend/src/ee-contract.js';
import { network } from './network/index.js';

export const modules: EeBackendModule[] = [network];
