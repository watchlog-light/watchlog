// SPDX-License-Identifier: AGPL-3.0-only
import { Type } from 'typebox';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../lib/passwords.js';

export const Email = Type.String({ format: 'email', maxLength: 254 });
export const NewPassword = Type.String({
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: MAX_PASSWORD_LENGTH,
});

export const CurrentUserSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  email: Type.String(),
  name: Type.String(),
  locale: Type.String(),
  role: Type.Union([Type.Literal('owner'), Type.Literal('admin'), Type.Literal('viewer')]),
  org: Type.Object({
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    slug: Type.String(),
    plan: Type.Union([
      Type.Literal('community'),
      Type.Literal('free'),
      Type.Literal('pro'),
      Type.Literal('enterprise'),
    ]),
  }),
});

export const UserEnvelope = Type.Object({ user: CurrentUserSchema });

/** GET /me: the user, and the API token the request came with (null with a session). */
export const MeResponse = Type.Object({
  user: CurrentUserSchema,
  token: Type.Union([
    Type.Object({
      name: Type.String(),
      /** "wl_pat_" and the first 4 characters of the random part. */
      prefix: Type.String(),
      scope: Type.Literal('read'),
      expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    }),
    Type.Null(),
  ]),
});

/** RFC 9457 problem body, for documenting error responses. */
export const ProblemSchema = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  detail: Type.Optional(Type.String()),
  instance: Type.Optional(Type.String()),
});
