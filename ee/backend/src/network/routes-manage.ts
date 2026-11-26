// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Changing and undoing what was set on the network pages (1.0.2): a credential profile is
// edited (a secret left empty is kept; the protocol never changes), deleted (after its
// devices were moved to another profile of the same protocol) and tried against one address
// before it is saved; an accepted certificate is un-accepted; a poller's devices are moved to
// another poller at once. Owners and Admins; every change is in the audit trail, with names
// and counts and never a secret.
//
// The test reuses discovery (ADR-233): one address, one credential, no neighbours, through the
// chosen poller, with discovery's own limits. The values as typed travel as a discovery of
// their own, sealed with the install's key and bound to that row; nothing is saved to a
// profile. A collector of any version runs it (recorders need 1.0.2).
import type {
  EeHost,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from '../../../../backend/src/ee-contract.js';
import { olderCollector, openSecret, sealSecret, type CredentialRow } from './credentials.js';

/**
 * How long a test may take before the page says the poller didn't answer. A 1.0.2 collector
 * reports a test as soon as it is done (seconds); an older one with its next round, a minute
 * after it started, so the limit is longer than a round.
 */
export const TEST_MS = 100_000;
/** Tests an org may start in a minute. */
export const TESTS_PER_MINUTE = 20;

export type TestOutcome =
  | 'answered'
  | 'refused'
  // SNMPv3's reports, said as which value is wrong (1.0.4, a collector from 1.0.4).
  | 'user'
  | 'auth'
  | 'privacy'
  | 'level'
  // The poller's collector is older than 1.0.4 and can't read these protocols.
  | 'collector_old'
  | 'no_answer'
  | 'certificate'
  | 'plain_refused'
  | 'unsupported'
  | 'poller_silent'
  | 'error';

/**
 * What a probe's error means, from the collector's own sentences (ee/collector/network: snmp.go,
 * routeros.go, dahua.go), which are the same in every version that has discovery.
 */
export function outcomeOf(error: string, protocol: string): TestOutcome {
  const e = error.toLowerCase();
  if (olderCollector(error)) return 'collector_old';
  if (/certificate changed/.test(e)) return 'certificate';
  if (/doesn't know this snmpv3 user/.test(e)) return 'user';
  if (/authentication password or protocol doesn't match/.test(e)) return 'auth';
  if (/privacy protocol or password doesn't match/.test(e)) return 'privacy';
  if (/wants another security level/.test(e)) return 'level';
  if (/refused the (snmp credentials|routeros user|user)/.test(e)) return 'refused';
  if (/sends the password in clear/.test(e)) return 'plain_refused';
  // A collector older than 1.0.2 has no recorder probe: it tries SNMP without a credential.
  if (protocol === 'dahua' && /no (snmp )?credential/.test(e)) return 'unsupported';
  if (
    /didn't answer|timeout|timed out|deadline|connection refused|no route|unreachable|i\/o|reset by peer|eof|no such host/.test(
      e,
    )
  )
    return 'no_answer';
  return 'error';
}

const SECRET_KEYS = ['community', 'authKey', 'privKey', 'password'] as const;
const SECRET_WORDS: Record<string, string> = {
  community: 'community',
  authKey: 'authentication key',
  privKey: 'privacy key',
  password: 'password',
};

/** The secrets a protocol and its settings use; the others are dropped. */
function secretsFor(protocol: string, settings: Record<string, unknown>): readonly string[] {
  if (protocol !== 'snmp') return ['password'];
  if (settings.version === '2c') return ['community'];
  // The keys the profile's level uses (1.0.4): none, the authentication key, or both.
  const level = (settings.level as string | undefined) ?? 'authPriv';
  return level === 'noAuthNoPriv'
    ? []
    : level === 'authNoPriv'
      ? ['authKey']
      : ['authKey', 'privKey'];
}

/** A form's secrets as typed: empty means "the saved one" while a profile is edited. */
const SecretAsTyped = {
  type: 'object',
  additionalProperties: false,
  properties: {
    community: { type: 'string', maxLength: 128 },
    authKey: { type: 'string', maxLength: 128 },
    privKey: { type: 'string', maxLength: 128 },
    password: { type: 'string', maxLength: 128 },
  },
};
/** What the creation schema checks by length, for a secret typed into an edit or a test. */
function shortKey(secret: Record<string, string>): string | null {
  for (const k of ['authKey', 'privKey'])
    if (secret[k] !== undefined && secret[k]!.length < 8)
      return 'An SNMPv3 key has at least 8 characters';
  return null;
}

export interface ManageHelpers {
  read: object;
  write: object;
  owner: object;
  tags: string[];
  ID: object;
  IdParams: object;
  ADDRESS: object;
  HOST: object;
  CredentialBody: { properties: Record<string, unknown> };
  orgOf(request: FastifyRequest): string;
  problem(reply: FastifyReply, status: number, detail: string): FastifyReply;
  checkCredential(
    b: { protocol: string; settings: Record<string, unknown>; secret?: Record<string, unknown> },
    creating: boolean,
  ): string | null;
  checkPoller(orgId: string, clusterId: string, host: string): Promise<string | null>;
  pollers(orgId: string): Promise<
    {
      clusterId: string;
      name: string;
      kind: string;
      hosts: { host: string; collector: boolean; reporting: boolean }[];
    }[]
  >;
}

export function registerManageRoutes(api: FastifyInstance, host: EeHost, h: ManageHelpers): void {
  const db = host.db;
  const { read, write, owner, tags, ID, IdParams, ADDRESS, HOST, orgOf, problem } = h;

  const profile = (orgId: string, id: string) =>
    db
      .selectFrom('network_credentials')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<(CredentialRow & { name: string }) | undefined>;

  const devicesOf = (orgId: string, credentialId: string) =>
    db
      .selectFrom('network_devices')
      .select(['id', 'name', 'address', 'kind', 'cluster_id', 'status'])
      .where('org_id', '=', orgId)
      .where('credential_id', '=', credentialId)
      .where('removed_at', 'is', null)
      .orderBy('name')
      .execute() as Promise<
      {
        id: string;
        name: string;
        address: string;
        kind: string;
        cluster_id: string;
        status: string;
      }[]
    >;

  const wake = (clusterIds: Iterable<string>) => {
    for (const id of new Set(clusterIds)) host.collector.notify(id);
  };

  // The devices a profile reads: the edit form's "3 devices use it", the delete dialog's list.
  api.get(
    '/network/credentials/:id/devices',
    { ...read, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      if (!(await profile(orgId, id))) return problem(reply, 404, 'Profile not found');
      return {
        devices: (await devicesOf(orgId, id)).map((d) => ({
          id: d.id,
          name: d.name,
          address: d.address,
          kind: d.kind,
        })),
      };
    },
  );

  api.patch(
    '/network/credentials/:id',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        params: IdParams,
        body: {
          ...h.CredentialBody,
          required: [],
          // A secret may be empty here: empty keeps the saved one.
          properties: { ...h.CredentialBody.properties, secret: SecretAsTyped },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const row = await profile(orgId, id);
      if (!row) return problem(reply, 404, 'Profile not found');
      const b = request.body as {
        name?: string;
        protocol?: string;
        settings?: Record<string, unknown>;
        secret?: Record<string, string>;
      };
      if (b.protocol && b.protocol !== row.protocol)
        return problem(
          reply,
          400,
          "A profile's protocol can't change: its devices are read with it. Make a new profile instead.",
        );
      const before = row.settings as Record<string, unknown>;
      const settings = { ...before, ...(b.settings ?? {}) };
      // A secret left out (or empty) is kept; one typed replaces it. Secrets of the other SNMP
      // version are dropped when the version changes.
      const old = openSecret(host, row) ?? {};
      const typed = Object.fromEntries(
        Object.entries(b.secret ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''),
      );
      const wanted = secretsFor(row.protocol, settings);
      const secret = Object.fromEntries(
        Object.entries({ ...old, ...typed }).filter(([k]) => wanted.includes(k)),
      ) as Record<string, string>;
      const bad =
        h.checkCredential({ protocol: row.protocol, settings, secret }, true) ?? shortKey(typed);
      if (bad) return problem(reply, 400, bad);
      const changed: string[] = [];
      if (b.name && b.name !== row.name) changed.push('name');
      for (const k of new Set([...Object.keys(before), ...Object.keys(settings)]))
        if (JSON.stringify(before[k]) !== JSON.stringify(settings[k])) changed.push(k);
      for (const k of SECRET_KEYS)
        if (k in typed && typed[k] !== (old as Record<string, string>)[k])
          changed.push(SECRET_WORDS[k]!);
      const secretChanged =
        JSON.stringify(secret) !== JSON.stringify(old) || Object.keys(typed).length > 0;
      try {
        await db
          .updateTable('network_credentials')
          .set({
            ...(b.name ? { name: b.name } : {}),
            settings: JSON.stringify(settings),
            ...(secretChanged ? { ciphertext: sealSecret(host, id, secret) } : {}),
            updated_at: new Date(host.now()),
          })
          .where('org_id', '=', orgId)
          .where('id', '=', id)
          .execute();
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          return problem(reply, 409, 'A profile with that name exists');
        throw err;
      }
      const used = await devicesOf(orgId, id);
      // Its devices are read with the new values from the next poll.
      wake(used.map((d) => d.cluster_id));
      if (changed.length)
        await host.audit(request, 'network_profile_changed', {
          profile: b.name ?? row.name,
          changed: changed.join(', '),
          devices: used.length,
        });
      return reply.code(204).send();
    },
  );

  api.delete(
    '/network/credentials/:id',
    { ...write, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const row = await profile(orgId, id);
      if (!row) return problem(reply, 404, 'Profile not found');
      const used = await devicesOf(orgId, id);
      if (used.length) {
        const detail =
          used.length === 1
            ? '1 device uses this profile; move it to another profile first'
            : `${used.length} devices use this profile; move them to another profile first`;
        // The devices, so the page can list them and offer the move.
        return reply
          .code(409)
          .type('application/problem+json')
          .send({
            title: detail,
            status: 409,
            detail,
            devices: used.map((d) => ({ id: d.id, name: d.name, address: d.address })),
          });
      }
      await db
        .deleteFrom('network_credentials')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .execute();
      await host.audit(request, 'network_profile_removed', {
        profile: row.name,
        protocol: row.protocol,
      });
      return reply.code(204).send();
    },
  );

  // Its devices to another profile of the same protocol: they are read with it from the next
  // poll, and the profile can then be deleted.
  api.post(
    '/network/credentials/:id/move',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        params: IdParams,
        body: {
          type: 'object',
          required: ['to'],
          additionalProperties: false,
          properties: { to: ID },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const { to } = request.body as { to: string };
      const [from, target] = await Promise.all([profile(orgId, id), profile(orgId, to)]);
      if (!from) return problem(reply, 404, 'Profile not found');
      if (!target || to === id)
        return problem(reply, 400, 'Choose another profile to move them to');
      if (target.protocol !== from.protocol)
        return problem(reply, 400, 'Choose a profile of the same protocol');
      const used = await devicesOf(orgId, id);
      if (used.length) {
        await db
          .updateTable('network_devices')
          .set({ credential_id: to, updated_at: new Date(host.now()) })
          .where('org_id', '=', orgId)
          .where('credential_id', '=', id)
          .where('removed_at', 'is', null)
          .execute();
        // A device that failed with the old profile is tried again at once.
        await db
          .updateTable('network_devices')
          .set({ status: 'pending', failures: 0 })
          .where('org_id', '=', orgId)
          .where('credential_id', '=', to)
          .where(
            'id',
            'in',
            used.map((d) => d.id),
          )
          .where('status', 'in', ['auth_failed', 'unreachable', 'error'])
          .execute();
        wake(used.map((d) => d.cluster_id));
        await host.audit(request, 'network_devices_moved', {
          from: from.name,
          to: target.name,
          devices: used.length,
        });
      }
      return { moved: used.length };
    },
  );

  // ------------------------------------------------------------------------- try a profile

  api.post(
    '/network/credential-tests',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        body: {
          type: 'object',
          required: ['clusterId', 'host', 'address', 'protocol', 'settings'],
          additionalProperties: false,
          properties: {
            clusterId: ID,
            host: HOST,
            address: ADDRESS,
            protocol: h.CredentialBody.properties.protocol,
            settings: h.CredentialBody.properties.settings,
            secret: SecretAsTyped,
            /** The profile being edited: secrets left empty are its saved ones. */
            credentialId: ID,
            /** "Find what works" (1.0.4): the combinations of protocols, with these passwords. */
            find: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const b = request.body as {
        clusterId: string;
        host: string;
        address: string;
        protocol: 'snmp' | 'routeros' | 'dahua';
        settings: Record<string, unknown>;
        secret?: Record<string, string>;
        credentialId?: string;
        find?: boolean;
      };
      if (
        b.find &&
        (b.protocol !== 'snmp' ||
          b.settings.version !== '3' ||
          (b.settings.level ?? 'authPriv') === 'noAuthNoPriv')
      )
        return problem(
          reply,
          400,
          '"Find what works" tries the protocols of an SNMPv3 profile with authentication',
        );
      const bad = await h.checkPoller(orgId, b.clusterId, b.host);
      if (bad) return problem(reply, 400, bad);
      const poller = (await h.pollers(orgId))
        .find((p) => p.clusterId === b.clusterId)
        ?.hosts.find((x) => x.host === b.host);
      if (!poller?.collector)
        return problem(
          reply,
          409,
          'This poller has no collector yet: install or upgrade its agent, then test again',
        );
      let saved: Record<string, string> = {};
      if (b.credentialId) {
        const row = await profile(orgId, b.credentialId);
        if (!row) return problem(reply, 404, 'Profile not found');
        if (row.protocol !== b.protocol)
          return problem(reply, 400, "A profile's protocol can't change");
        saved = (openSecret(host, row) ?? {}) as Record<string, string>;
      }
      const typed = Object.fromEntries(
        Object.entries(b.secret ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''),
      );
      const wanted = secretsFor(b.protocol, b.settings);
      const secret = Object.fromEntries(
        Object.entries({ ...saved, ...typed }).filter(([k]) => wanted.includes(k)),
      ) as Record<string, string>;
      const wrong = h.checkCredential({ protocol: b.protocol, settings: b.settings, secret }, true);
      if (wrong) return problem(reply, 400, wrong);
      const short = shortKey(typed);
      if (short) return problem(reply, 400, short);
      const recent = await db
        .selectFrom('network_discoveries')
        .select(db.fn.countAll().as('n'))
        .where('org_id', '=', orgId)
        .where('created_at', '>', new Date(host.now() - 60_000))
        .where(host.sql<boolean>`jsonb_exists(request, 'test')`)
        .executeTakeFirst();
      if (Number(recent?.n ?? 0) >= TESTS_PER_MINUTE)
        return problem(reply, 429, 'Too many tests in a minute: wait a moment');
      // A device already at this address has a pinned certificate: the test holds to it, so a
      // changed certificate shows here as it would in a poll.
      const known = await db
        .selectFrom('network_devices')
        .select(['cert_pin'])
        .where('org_id', '=', orgId)
        .where('address', '=', b.address)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      const id = host.newId();
      await db
        .insertInto('network_discoveries')
        .values({
          id,
          org_id: orgId,
          cluster_id: b.clusterId,
          poller_host: b.host,
          request: JSON.stringify({
            seeds: [b.address],
            range: '',
            neighbours: false,
            credentialIds: [],
            test: {
              protocol: b.protocol,
              settings: b.settings,
              ciphertext: sealSecret(host, id, secret),
              ...(known?.cert_pin ? { pin: known.cert_pin } : {}),
              ...(b.find ? { find: true } : {}),
            },
          }),
          expires_at: new Date(host.now() + TEST_MS),
        })
        .execute();
      host.collector.notify(b.clusterId);
      return reply.code(201).send({ id });
    },
  );

  api.get(
    '/network/credential-tests/:id',
    { ...write, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const r = await db
        .selectFrom('network_discoveries')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      const q = r?.request as { seeds: string[]; test?: { protocol: string } } | undefined;
      if (!r || !q?.test) return problem(reply, 404, 'Test not found');
      const address = q.seeds[0] ?? '';
      const found = ((r.found ?? []) as Record<string, unknown>[]).find(
        (f) => f.address === address,
      );
      const expired = new Date(r.expires_at).getTime() < host.now();
      if (!found && !r.done && !expired) return { id, done: false };
      // Finished: the row goes, and its sealed secret with it.
      await db
        .deleteFrom('network_discoveries')
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .execute();
      if (!found) {
        return { id, done: true, address, outcome: 'poller_silent' satisfies TestOutcome };
      }
      // "Find what works": which combination answered, and how many were tried.
      const finding = (q.test as { find?: boolean }).find === true;
      const tried = Array.isArray(found.tried) ? (found.tried as unknown[]).length : undefined;
      const combo = finding ? comboOf(String(found.credential ?? '')) : null;
      if (found.answered) {
        return {
          id,
          done: true,
          address,
          outcome: 'answered' satisfies TestOutcome,
          name: String(found.name ?? ''),
          model: String(found.model ?? ''),
          vendor: String(found.vendor ?? ''),
          profile: String(found.profile ?? ''),
          ...(combo ? { found: combo } : {}),
          ...(finding && tried !== undefined ? { tried } : {}),
        };
      }
      const error = String(found.error ?? '');
      const outcome = outcomeOf(error, q.test.protocol);
      const what = olderCollector(error);
      return {
        id,
        done: true,
        address,
        outcome,
        ...(what ? { collector: what } : {}),
        ...(finding && tried !== undefined ? { tried } : {}),
        // The collector's own sentence, only when it is none of the known cases.
        ...(outcome === 'error' ? { detail: error.slice(0, 300) } : {}),
      };
    },
  );

  // ------------------------------------------------------------------ an accepted certificate

  // An accept made by mistake, undone by an Owner: the certificate pinned before is pinned
  // again. If the device still shows the new one, it is "certificate changed" again at its
  // next poll and waits for an Owner, as before the accept.
  api.post(
    '/network/devices/:id/restore-certificate',
    { ...owner, schema: { tags, hide: true, params: IdParams } },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { id } = request.params as { id: string };
      const d = await db
        .selectFrom('network_devices')
        .select(['id', 'name', 'cluster_id', 'cert_prev'])
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (!d) return problem(reply, 404, 'Device not found');
      if (!d.cert_prev) return problem(reply, 409, 'No accepted certificate to undo');
      await db
        .updateTable('network_devices')
        .set({
          cert_pin: d.cert_prev,
          cert_prev: null,
          cert_seen: null,
          status: 'pending',
          failures: 0,
          updated_at: new Date(host.now()),
        })
        .where('id', '=', id)
        .execute();
      await db
        .insertInto('network_events')
        .values({
          id: host.newId(),
          org_id: orgId,
          device_id: id,
          port: '',
          reason: 'CertificateRestored',
          severity: 'info',
          message:
            'An Owner undid the accepted certificate: the one pinned before is pinned again.',
          at: new Date(host.now()),
        })
        .execute();
      host.collector.notify(d.cluster_id);
      await host.audit(request, 'network_certificate_restored', { device: d.name });
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------------------ a poller

  const Poller = {
    type: 'object',
    required: ['clusterId', 'host'],
    additionalProperties: false,
    properties: { clusterId: ID, host: HOST },
  };

  // Every device one poller reads, to another poller: when a server stops being a good one.
  api.post(
    '/network/pollers/move',
    {
      ...write,
      schema: {
        tags,
        hide: true,
        body: {
          type: 'object',
          required: ['from', 'to'],
          additionalProperties: false,
          properties: { from: Poller, to: Poller },
        },
      },
    },
    async (request, reply) => {
      const orgId = orgOf(request);
      const { from, to } = request.body as {
        from: { clusterId: string; host: string };
        to: { clusterId: string; host: string };
      };
      if (from.clusterId === to.clusterId && from.host === to.host)
        return problem(reply, 400, 'Choose another poller to move them to');
      const bad = await h.checkPoller(orgId, to.clusterId, to.host);
      if (bad) return problem(reply, 400, bad);
      const rows = (await db
        .selectFrom('network_devices')
        .select(['id'])
        .where('org_id', '=', orgId)
        .where('cluster_id', '=', from.clusterId)
        .where('poller_host', '=', from.host)
        .where('removed_at', 'is', null)
        .execute()) as { id: string }[];
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        await db
          .updateTable('network_devices')
          .set({
            cluster_id: to.clusterId,
            poller_host: to.host,
            failures: 0,
            updated_at: new Date(host.now()),
          })
          .where('org_id', '=', orgId)
          .where('id', 'in', ids)
          .execute();
        // Paused devices and changed certificates keep their state; the rest are tried anew.
        await db
          .updateTable('network_devices')
          .set({ status: 'pending' })
          .where('org_id', '=', orgId)
          .where('id', 'in', ids)
          .where('status', 'not in', ['paused', 'cert_changed'])
          .execute();
        wake([from.clusterId, to.clusterId]);
        const names = new Map((await h.pollers(orgId)).map((p) => [p.clusterId, p.name]));
        const say = (p: { clusterId: string; host: string }) =>
          p.host ? `${p.host} (${names.get(p.clusterId) ?? ''})` : (names.get(p.clusterId) ?? '');
        await host.audit(request, 'network_poller_moved', {
          from: say(from),
          to: say(to),
          devices: rows.length,
        });
      }
      return { moved: rows.length };
    },
  );
}

/** A "Find what works" candidate's id, `<test id>|<auth>|<priv>`, as protocols. */
export function comboOf(id: string): { authProto: string; privProto: string } | null {
  const [, auth, priv] = id.split('|');
  if (!auth || !priv) return null;
  return { authProto: auth, privProto: priv };
}
