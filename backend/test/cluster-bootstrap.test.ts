// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapCluster } from '../src/app.js';
import { ensureBootstrapCluster } from '../src/modules/clusters/bootstrap.js';
import { verifyClusterToken } from '../src/modules/clusters/tokens.js';
import {
  closeTestContext,
  createTestContext,
  setupAdmin,
  testConfig,
  type TestContext,
} from './helpers.js';

// Shaped like the token the Helm chart generates: wl_ct_ + 43 alphanumerics (ADR-069).
const TOKEN = `wl_ct_${'Ab3'.repeat(14)}x`;

describe('Kubernetes clusters: Helm bootstrap and install command', () => {
  let ctx: TestContext;
  afterEach(() => closeTestContext(ctx));

  it('creates the cluster with the chart token after first-run setup, once', async () => {
    ctx = await createTestContext({ bootstrapCluster: { name: 'production', token: TOKEN } });
    expect(await ensureBootstrapCluster(ctx.db, 'production', TOKEN)).toBe('no-org');
    await setupAdmin(ctx.app); // the setup route runs the bootstrap
    const owner = await verifyClusterToken(ctx.db, TOKEN);
    expect(owner).not.toBeNull();
    const cluster = await ctx.db.selectFrom('clusters').selectAll().executeTakeFirstOrThrow();
    expect(cluster).toMatchObject({ id: owner!.clusterId, name: 'production', kind: 'kubernetes' });
    expect(await ensureBootstrapCluster(ctx.db, 'production', TOKEN)).toBe('exists');
    expect(await ctx.db.selectFrom('cluster_tokens').selectAll().execute()).toHaveLength(1);
  });

  it('does not bring back a bootstrap cluster the user deleted, or a token they revoked', async () => {
    ctx = await createTestContext({ bootstrapCluster: { name: 'production', token: TOKEN } });
    const cookie = await setupAdmin(ctx.app);
    const cluster = await ctx.db.selectFrom('clusters').selectAll().executeTakeFirstOrThrow();
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/clusters/${cluster.id}`,
      cookies: { wl_session: cookie },
    });
    expect(del.statusCode).toBe(204);
    expect(await verifyClusterToken(ctx.db, TOKEN)).toBeNull();
    // A backend restart runs the bootstrap again with the same environment.
    expect(await ensureBootstrapCluster(ctx.db, 'production', TOKEN)).toBe('deleted');
    await bootstrapCluster(
      ctx.app,
      testConfig({ bootstrapCluster: { name: 'production', token: TOKEN } }),
      ctx.db,
    );
    expect(await ctx.db.selectFrom('clusters').selectAll().execute()).toHaveLength(0);
    expect(await verifyClusterToken(ctx.db, TOKEN)).toBeNull();
  });

  it('keeps a revoked bootstrap token revoked', async () => {
    ctx = await createTestContext({ bootstrapCluster: { name: 'production', token: TOKEN } });
    const cookie = await setupAdmin(ctx.app);
    const cluster = await ctx.db.selectFrom('clusters').selectAll().executeTakeFirstOrThrow();
    const token = await ctx.db.selectFrom('cluster_tokens').selectAll().executeTakeFirstOrThrow();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/clusters/${cluster.id}/tokens/${token.id}`,
      cookies: { wl_session: cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await ensureBootstrapCluster(ctx.db, 'production', TOKEN)).toBe('revoked');
    expect(await verifyClusterToken(ctx.db, TOKEN)).toBeNull();
    expect(await ctx.db.selectFrom('cluster_tokens').selectAll().execute()).toHaveLength(1);
  });

  it('returns a helm command for Kubernetes clusters', async () => {
    ctx = await createTestContext({ publicUrl: 'https://watchlog.example.com' });
    const cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/clusters',
      cookies: { wl_session: cookie },
      payload: { name: 'kind', kind: 'kubernetes' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cluster.kind).toBe('kubernetes');
    expect(body.install.dockerRun).toBeUndefined();
    expect(body.install.helm.split('\n').slice(0, 4)).toEqual([
      'kubectl create namespace watchlog && \\',
      'kubectl label namespace watchlog pod-security.kubernetes.io/enforce=privileged && \\',
      'helm install watchlog-agent deploy/helm/watchlog-agent \\',
      '  --namespace watchlog \\',
    ]);
    expect(body.install.helm).toContain('--set watchlog.endpoint=https://watchlog.example.com');
    expect(body.install.helm).toContain(`--set watchlog.clusterToken=${body.token.value}`);
  });
});
