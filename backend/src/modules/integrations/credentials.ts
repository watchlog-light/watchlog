// SPDX-License-Identifier: AGPL-3.0-only
// A service's access (ADR-133, ADR-134): a password WatchLog generates with the exact
// command that creates the least-privileged user, a user the owner already has, or a
// Secret or file WatchLog only references. Passwords are encrypted with the instance's
// key, bound to their row, write-only, and reach only the collector that needs them.
import { randomInt } from 'node:crypto';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import type { IntegrationTarget, IntegrationType } from './collector-config.js';

/** What the connect drawer or the settings drawer sends. */
export type Access =
  | { method: 'none' }
  | { method: 'generated'; username?: string }
  | { method: 'entered'; username: string; password: string }
  | {
      method: 'reference';
      username?: string;
      /** Kubernetes: a Secret in the collector's namespace and its key. */
      secret?: { name: string; key: string };
      /** Docker: a file under /etc/watchlog/secrets on the host. */
      file?: string;
    };

export type StoredMethod = 'generated' | 'entered' | 'reference';

/** Where a referenced password lives. */
export interface Reference {
  secret?: { namespace: string; name: string; key: string };
  file?: string;
}

/** What the collector receives for one target or probe. */
export interface CollectorCredential {
  username?: string;
  password?: string;
  secret?: { namespace: string; name: string; key: string };
  file?: string;
}

/** The user WatchLog creates (option a) unless told otherwise. */
export const DEFAULT_USER = 'watchlog';
/** The collector's namespace when it hasn't reported one yet (the docs' install). */
export const DEFAULT_NAMESPACE = 'watchlog';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `wl_mon_` and 25 random letters and digits: 32 characters, safe in any shell quote. */
export function generatePassword(): string {
  let out = 'wl_mon_';
  for (let i = 0; i < 25; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Types whose access is a user (the others need nothing, ADR-134). */
export const USER_TYPES: ReadonlySet<IntegrationType> = new Set([
  'postgres',
  'mysql',
  'redis',
  'mongodb',
  'kafka',
  'elasticsearch',
]);

/** The statements that create the least-privileged user, per type. */
function createUser(type: IntegrationType, user: string, password: string): string[] | null {
  switch (type) {
    case 'postgres':
      return [
        'psql',
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `"CREATE ROLE ${user} LOGIN PASSWORD '${password}'"`,
        '-c',
        `"GRANT pg_monitor TO ${user}"`,
      ];
    case 'redis':
      // Read-only commands only; ~* lets MEMORY USAGE and SCAN see key names (ADR-134).
      return [
        'redis-cli',
        'ACL',
        'SETUSER',
        user,
        'reset',
        'on',
        `'>${password}'`,
        `'~*'`,
        '+info',
        '+ping',
        '+slowlog',
        '+latency',
        `'+config|get'`,
        `'+client|list'`,
        `'+memory|stats'`,
        `'+memory|usage'`,
        '+scan',
      ];
    case 'mysql':
      // One form for MySQL and MariaDB (ADR-163): the shell picks the client the image
      // has (MariaDB 11 has no `mysql`), `-p` asks for root's password, and `/*M!…*/`
      // grants REPLICA MONITOR only on MariaDB, which needs it for SHOW REPLICA STATUS.
      // Backticks and double quotes keep the SQL inside one single-quoted argument.
      return [
        'sh',
        '-c',
        `'exec "$(command -v mariadb || command -v mysql)" -uroot -p -e "$0"'`,
        `'${mysqlGrants(user, password)}'`,
      ];
    case 'mongodb':
      // clusterMonitor reads everything WatchLog shows, the oplog's first and last entries
      // included (measured on 7.0 and 8.0, ADR-164). `-p` without a value asks for root's
      // password; on a server without authentication, the user is still made, unused.
      return [
        'mongosh',
        '-u',
        'root',
        '-p',
        '--authenticationDatabase',
        'admin',
        '--quiet',
        '--eval',
        `'${mongoUser(user, password)}'`,
      ];
    case 'kafka':
      // A SCRAM-SHA-512 user with Describe on the cluster, every topic and every group, and
      // DescribeConfigs on topics (ADR-166). Run in a broker, through its own listener; the
      // tools are on PATH in Bitnami's and Confluent's images, in /opt/kafka/bin in Apache's
      // and Strimzi's (the native image has none: run it from any Kafka image).
      return ['sh', '-c', `'${kafkaUser(user, password)}'`];
    default:
      return null;
  }
}

/** The commands that create Kafka's monitoring user and its ACLs (ADR-166). */
export function kafkaUser(user: string, password: string): string {
  const bs = '--bootstrap-server localhost:9092';
  return [
    'PATH="$PATH:/opt/kafka/bin:/opt/bitnami/kafka/bin"',
    `kafka-configs.sh ${bs} --alter --entity-type users --entity-name ${user} --add-config "SCRAM-SHA-512=[password=${password}]"`,
    `kafka-acls.sh ${bs} --add --allow-principal User:${user} --operation Describe --cluster --topic "*" --group "*"`,
    `kafka-acls.sh ${bs} --add --allow-principal User:${user} --operation DescribeConfigs --topic "*"`,
  ].join(' && ');
}

/** The statement that creates MongoDB's monitoring user (ADR-164). */
export function mongoUser(user: string, password: string): string {
  return `db.getSiblingDB("admin").createUser({ user: "${user}", pwd: "${password}", roles: [{ role: "clusterMonitor", db: "admin" }] })`;
}

/** The statements that create MySQL's or MariaDB's monitoring user (ADR-163). */
export function mysqlGrants(user: string, password: string): string {
  const u = `\`${user}\`@\`%\``;
  return [
    `CREATE USER ${u} IDENTIFIED BY "${password}" WITH MAX_USER_CONNECTIONS 2`,
    `GRANT PROCESS, REPLICATION CLIENT /*M!100509 , SLAVE MONITOR */ ON *.* TO ${u}`,
    `GRANT SELECT ON performance_schema.* TO ${u}`,
    `GRANT SELECT ON mysql.innodb_table_stats TO ${u}`,
  ].join('; ');
}

/** Types whose command asks for a password at the terminal (`exec -it`). */
const INTERACTIVE: ReadonlySet<IntegrationType> = new Set(['mysql', 'mongodb']);

/**
 * The one-time command that creates WatchLog's user (option a), with the names the
 * agents saw: `kubectl exec` into the workload, `docker exec` into the container, or
 * the bare statement for an address added by hand. Null for types that need no user.
 */
export function connectCommand(
  type: IntegrationType,
  target: IntegrationTarget,
  password: string,
  opts: { user?: string; container?: string | null } = {},
): string | null {
  const stmt = createUser(type, opts.user ?? DEFAULT_USER, password);
  if (!stmt) return null;
  const line = stmt.join(' ');
  const it = INTERACTIVE.has(type) ? '-it ' : '';
  switch (target.kind) {
    case 'workload':
      return `kubectl exec ${it}-n ${target.namespace} ${target.workload_kind.toLowerCase()}/${target.workload} -- ${line}`;
    case 'compose':
    case 'container':
      return `docker exec ${it}${opts.container ?? (target.kind === 'container' ? target.container : `${target.compose_project}-${target.compose_service}-1`)} ${line}`;
    case 'address':
      return type === 'mysql'
        ? `mysql -uroot -p -e '${mysqlGrants(opts.user ?? DEFAULT_USER, password)}'`
        : type === 'mongodb'
          ? `mongosh "mongodb://${target.address}/?directConnection=true" -u root -p --authenticationDatabase admin --quiet --eval '${mongoUser(opts.user ?? DEFAULT_USER, password)}'`
          : line;
  }
}

/** The Role and RoleBinding that let only the collector read one Secret (ADR-134). */
export function secretRoleCommands(
  secret: string,
  namespace: string,
  serviceAccount: string,
): string[] {
  const role = `watchlog-read-${secret}`.slice(0, 63);
  return [
    `kubectl create role ${role} -n ${namespace} --verb=get --resource=secrets --resource-name=${secret}`,
    `kubectl create rolebinding ${role} -n ${namespace} --role=${role} --serviceaccount=${namespace}:${serviceAccount}`,
  ];
}

/** The file a Docker host keeps the password in, and the mount the collector needs. */
export function fileCommands(file: string): string[] {
  return [
    'sudo install -d -m 0700 /etc/watchlog/secrets',
    `sudo sh -c 'umask 077; cat > /etc/watchlog/secrets/${file}'   # paste the password, then Ctrl-D`,
  ];
}

/** The stored form of an access: the method, user, ciphertext (bound to `rowId`) or reference. */
export function sealAccess(
  key: Buffer,
  rowId: string,
  access: Exclude<Access, { method: 'none' }>,
  generated: string | null,
  namespace: string,
): {
  method: StoredMethod;
  username: string | null;
  ciphertext: string | null;
  reference: Reference | null;
} {
  switch (access.method) {
    case 'generated':
      return {
        method: 'generated',
        username: access.username ?? DEFAULT_USER,
        ciphertext: encryptSecret(key, generated!, rowId),
        reference: null,
      };
    case 'entered':
      return {
        method: 'entered',
        username: access.username,
        ciphertext: encryptSecret(key, access.password, rowId),
        reference: null,
      };
    case 'reference':
      return {
        method: 'reference',
        username: access.username ?? null,
        ciphertext: null,
        reference: access.secret
          ? { secret: { namespace, name: access.secret.name, key: access.secret.key } }
          : { file: access.file! },
      };
  }
}

/** What the collector gets for a sealed access; null when the row has none. */
export function openAccess(
  key: Buffer,
  rowId: string,
  row: { method: string; username: string | null; ciphertext: string | null; reference: unknown },
): CollectorCredential {
  const user = row.username ? { username: row.username } : {};
  if (row.method === 'reference') {
    const ref = (row.reference ?? {}) as Reference;
    return { ...user, ...(ref.secret ? { secret: ref.secret } : { file: ref.file }) };
  }
  return { ...user, password: decryptSecret(key, row.ciphertext!, rowId) };
}

/** Moves a probe's sealed access to the service it becomes (a new row id, re-bound). */
export function rebind(
  key: Buffer,
  fromId: string,
  toId: string,
  row: { method: string; username: string | null; ciphertext: string | null; reference: unknown },
): {
  method: StoredMethod;
  username: string | null;
  ciphertext: string | null;
  reference: Reference | null;
} {
  return {
    method: row.method as StoredMethod,
    username: row.username,
    ciphertext: row.ciphertext
      ? encryptSecret(key, decryptSecret(key, row.ciphertext, fromId), toId)
      : null,
    reference: (row.reference as Reference | null) ?? null,
  };
}

export type EventAction =
  | 'monitored'
  | 'credential_set'
  | 'credential_replaced'
  | 'credential_removed'
  | 'verified'
  | 'paused'
  | 'resumed'
  | 'settings_changed'
  | 'removed';

/** One line of the service's log (ADR-133): who, when, from where; never a password. */
export async function recordEvent(
  db: Database,
  e: {
    orgId: string;
    integrationId: string;
    action: EventAction;
    user?: { id: string; name: string | null; email: string } | null;
    ip?: string | null;
    details?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await db
    .insertInto('integration_events')
    .values({
      id: newId(),
      org_id: e.orgId,
      integration_id: e.integrationId,
      action: e.action,
      user_id: e.user?.id ?? null,
      user_name: e.user ? (e.user.name ?? e.user.email).slice(0, 256) : null,
      ip: e.ip?.slice(0, 64) ?? null,
      details: JSON.stringify(e.details ?? {}),
    })
    .execute();
}
