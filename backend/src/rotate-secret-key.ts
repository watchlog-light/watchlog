// SPDX-License-Identifier: AGPL-3.0-only
// `backend rotate-secret-key` (ADR-133): re-encrypts every stored secret (alert channels,
// the SMTP password, integration credentials and pending probes) from the old key to the
// new one in one transaction, then the key check. Run it with both keys set:
//   WATCHLOG_SECRET_KEY_PREVIOUS=<old> WATCHLOG_SECRET_KEY=<new> node dist/rotate-secret-key.js
// Keep WATCHLOG_SECRET_KEY_PREVIOUS set until every backend and worker runs with the new
// key: they still decrypt with the old one meanwhile, so a rolling restart never fails.
import { loadDatabaseUrl } from './config.js';
import { createDb, describeDbError } from './db/index.js';
import { parseSecretKey, rotateSecretKey, SecretKeyError } from './lib/secrets.js';

const databaseUrl = loadDatabaseUrl();
let db: ReturnType<typeof createDb> | undefined;
try {
  if (!process.env.WATCHLOG_SECRET_KEY_PREVIOUS) {
    throw new SecretKeyError(
      'Set WATCHLOG_SECRET_KEY_PREVIOUS to the current key and WATCHLOG_SECRET_KEY to the new one.',
    );
  }
  const oldKey = parseSecretKey(process.env.WATCHLOG_SECRET_KEY_PREVIOUS);
  const newKey = parseSecretKey(process.env.WATCHLOG_SECRET_KEY);
  if (oldKey.equals(newKey)) throw new SecretKeyError('The new key is the same as the old one.');
  db = createDb(databaseUrl);
  const n = await rotateSecretKey(db, oldKey, newKey);
  console.log(
    `re-encrypted ${n.channels} alert channel, ${n.settings} settings, ${n.integrations} integration and ${n.probes} probe secrets with the new key`,
  );
} catch (err) {
  console.error(
    err instanceof SecretKeyError
      ? `rotate-secret-key: ${err.message}`
      : `rotate-secret-key failed: ${describeDbError(err, databaseUrl)}`,
  );
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
