// SPDX-License-Identifier: AGPL-3.0-only
import { Type, type TSchema } from 'typebox';
import { DEFAULT_EXPIRY_DAYS, EXPIRY_DAYS } from './tokens.js';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const DateTime = Type.String({ format: 'date-time' });

export const ApiTokenIdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const CreateApiTokenBody = Type.Object(
  {
    // No control characters: the name goes into the expiry reminder's subject.
    name: Type.String({ minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001f\\u007f]*$' }),
    expiresInDays: Type.Optional(
      Nullable(
        Type.Union(
          EXPIRY_DAYS.map((d) => Type.Literal(d)),
          { description: `Days until it expires (default ${DEFAULT_EXPIRY_DAYS}); null: never` },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export const ApiTokenSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  /** "wl_pat_" and the first 4 characters of the random part. */
  prefix: Type.String(),
  scope: Type.Literal('read'),
  createdAt: DateTime,
  expiresAt: Nullable(DateTime),
  status: Type.Union([
    Type.Literal('active'),
    Type.Literal('expires_soon'),
    Type.Literal('never'),
    Type.Literal('expired'),
    Type.Literal('revoked'),
  ]),
  lastUsedAt: Nullable(DateTime),
  /** The full address while the token can be used; its /24 or /48 network afterwards. */
  lastUsedIp: Nullable(Type.String()),
  lastUsedCountry: Nullable(Type.String()),
  usedRest: Type.Boolean(),
  mcpCalls30d: Type.Integer({ minimum: 0 }),
  revokedAt: Nullable(DateTime),
});

export const ApiTokenListSchema = Type.Object({ tokens: Type.Array(ApiTokenSchema) });

export const CreatedApiTokenSchema = Type.Object({
  /** The token itself: shown once, never stored. */
  value: Type.String(),
  token: ApiTokenSchema,
});

export const ApiTokenEventSchema = Type.Object({
  at: DateTime,
  kind: Type.Union([
    Type.Literal('created'),
    Type.Literal('first_use'),
    Type.Literal('new_ip'),
    Type.Literal('expired'),
    Type.Literal('revoked'),
    Type.Literal('reminder_sent'),
    // Cloud support mode (ADR-179): read by WatchLog staff in a support session.
    Type.Literal('staff_access'),
  ]),
  ip: Nullable(Type.String()),
  country: Nullable(Type.String()),
  expiresAt: Type.Optional(Nullable(DateTime)),
  by: Type.Optional(Nullable(Type.Object({ id: Type.String(), name: Type.String() }))),
});

export const ApiTokenDetailSchema = Type.Object({
  token: ApiTokenSchema,
  /** Newest first. */
  history: Type.Array(ApiTokenEventSchema),
  /** MCP tool calls, the last 50, newest first; never their output (ADR-127). */
  activity: Type.Array(
    Type.Object({
      at: DateTime,
      tool: Type.String(),
      /** A short summary of the arguments, written by WatchLog. */
      args: Type.String(),
      status: Type.Union([
        Type.Literal('ok'),
        Type.Literal('truncated'),
        Type.Literal('rate_limited'),
        Type.Literal('error'),
      ]),
      durationMs: Type.Integer({ minimum: 0 }),
      bytes: Type.Integer({ minimum: 0 }),
    }),
  ),
});
