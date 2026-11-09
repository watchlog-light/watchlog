// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ApiToken,
  ApiTokenEvent,
  ApiTokenStatus,
  Cluster,
  ClusterToken,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateClusterResponse,
  CurrentUser,
  DockerContainer,
  DockerHost,
  MetricKey,
  RangeQueryResponse,
  HealthResponse,
  LoginRequest,
  SetupRequest,
  SetupStatus,
} from './index.js';

describe('generated API types', () => {
  it('HealthResponse has a literal ok status and a version string', () => {
    expectTypeOf<HealthResponse['status']>().toEqualTypeOf<'ok'>();
    expectTypeOf<HealthResponse['version']>().toBeString();
  });

  it('CurrentUser carries the role and org plan unions', () => {
    expectTypeOf<CurrentUser['role']>().toEqualTypeOf<'owner' | 'admin' | 'viewer'>();
    expectTypeOf<CurrentUser['org']['plan']>().toEqualTypeOf<
      'community' | 'free' | 'pro' | 'enterprise'
    >();
  });

  it('request bodies match the backend schemas', () => {
    expectTypeOf<LoginRequest>().toEqualTypeOf<{ email: string; password: string }>();
    expectTypeOf<SetupRequest>().toHaveProperty('code').toBeString();
    expectTypeOf<SetupStatus>().toEqualTypeOf<{
      required: boolean;
      demoMode: boolean;
      demoMcpToken: string | null;
      smtp: boolean;
    }>();
  });

  it('cluster types expose status unions and the one-time token value', () => {
    expectTypeOf<Cluster['status']>().toEqualTypeOf<'pending' | 'active' | 'inactive'>();
    expectTypeOf<Cluster['lastSeenAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<CreateClusterResponse['token']['value']>().toBeString();
    expectTypeOf<ClusterToken>().not.toHaveProperty('value');
  });

  it('Docker and query types expose the fields the web app uses', () => {
    expectTypeOf<DockerHost['containers']['unhealthy']>().toBeNumber();
    expectTypeOf<DockerHost['cpuUtilization']>().toEqualTypeOf<number | null>();
    expectTypeOf<DockerContainer['composeProject']>().toEqualTypeOf<string | null>();
    expectTypeOf<'container.cpu.usage'>().toExtend<MetricKey>();
    expectTypeOf<RangeQueryResponse['series'][number]['points']>().toEqualTypeOf<
      (number | null)[][]
    >();
  });

  it('API token types show the value only when a token is created', () => {
    expectTypeOf<CreateApiTokenResponse['value']>().toBeString();
    expectTypeOf<ApiToken>().not.toHaveProperty('value');
    expectTypeOf<ApiTokenStatus>().toEqualTypeOf<
      'active' | 'expires_soon' | 'never' | 'expired' | 'revoked'
    >();
    expectTypeOf<CreateApiTokenRequest['expiresInDays']>().toEqualTypeOf<
      30 | 90 | 365 | null | undefined
    >();
    expectTypeOf<ApiTokenEvent['kind']>().toEqualTypeOf<
      'created' | 'first_use' | 'new_ip' | 'expired' | 'revoked' | 'reminder_sent'
    >();
  });
});
