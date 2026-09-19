import test from 'node:test';
import assert from 'node:assert/strict';
import { openPlatform } from '../dist/platform.js';
import { dashboardFixture, isDashboardQuotaRead } from '../scripts/load/performance-platform.mjs';

test('dashboard quota reads scale with distinct owners and workspaces, preserving fresh tenant authority', async t => {
  const fixture = await dashboardFixture(openPlatform, { projects: 10 });
  const { database, user, organizationId } = fixture;
  try {
    const read = async expectedReads => {
      const prototype = Object.getPrototypeOf(database.prepare('SELECT 1'));
      let count = 0;
      const spies = ['all', 'get'].map(name => {
        const original = prototype[name];
        return t.mock.method(prototype, name, function (...parameters) {
          if (isDashboardQuotaRead(this.sourceSQL)) count++;
          return original.apply(this, parameters);
        });
      });
      let result;
      try { result = await fixture.read(); }
      finally { for (const spy of spies) spy.mock.restore(); }
      assert.equal(count, expectedReads);
      return result;
    };
    const initial = await read(4);
    assert.equal(initial.projects.length, 10);
    const now = Date.now();
    database.prepare(`INSERT INTO clank_auth_users (id,email,password_hash,role,profile,created_at,updated_at)
      VALUES ('other-owner','other-owner@example.invalid','unused','user','{}',?,?)`).run(now, now);
    database.prepare(`INSERT INTO clank_platform_organizations (id,name,slug,created_by,created_at,updated_at)
      VALUES ('shared-workspace','Shared','shared-workspace','other-owner',?,?)`).run(now, now);
    database.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)')
      .run('shared-workspace', user.id, 'viewer', now, now);
    database.prepare(`INSERT INTO clank_platform_projects
      (id,owner_id,organization_id,name,slug,port,created_at,updated_at)
      VALUES ('shared-project','other-owner','shared-workspace','Shared project','shared-project',13000,?,?)`).run(now, now);
    database.prepare(`INSERT INTO clank_platform_quota_overrides
      (scope_type,scope_id,quota_key,quota_value,updated_by,updated_at)
      VALUES ('account','other-owner','bucketObjectsPerProject',888,?,?)`).run(user.id, now);
    const shared = await read(8);
    assert.equal(shared.projects.length, 11);
    assert.equal(shared.projects.find(project => project.id === 'shared-project').buckets.objectLimit, 888);
    assert.equal(shared.projects.find(project => project.organizationId === organizationId).buckets.objectLimit,
      initial.projects[0].buckets.objectLimit);
    database.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?')
      .run('shared-workspace', user.id);
    const removed = await read(4);
    assert.equal(removed.projects.length, 10);
    assert.equal(removed.projects.some(project => project.id === 'shared-project'), false);
    database.prepare('DELETE FROM clank_auth_sessions WHERE user_id=?').run(user.id);
    const revoked = await fixture.runtime.handle(new Request('http://127.0.0.1:4200/api/dashboard', {
      headers: { cookie: fixture.cookie },
    }));
    assert.equal(revoked.status, 401);
  } finally { await fixture.close(); }
});

test('dashboard quota snapshots expire after each request and preserve billing and override precedence', async () => {
  const fixture = await dashboardFixture(openPlatform, { projects: 3, metricBuckets: 3 });
  const { database, user, organizationId } = fixture;
  try {
    const initial = await fixture.read(), now = Date.now();
    database.prepare(`INSERT INTO clank_platform_billing_accounts
      (account_id,plan_id,status,quota_snapshot,created_at,updated_at) VALUES (?,'manual-test','manual',?,?,?)`)
      .run(user.id, JSON.stringify({ bucketObjectsPerProject: 456, releasesPerProject: 75 }), now, now);
    const billed = await fixture.read();
    assert.equal(billed.projects[0].buckets.objectLimit, 456);
    assert.equal(billed.projects[0].releases.limit, 75);
    assert.deepEqual(billed.projects[0].metrics, initial.projects[0].metrics);
    const override = database.prepare(`INSERT INTO clank_platform_quota_overrides
      (scope_type,scope_id,quota_key,quota_value,updated_by,updated_at) VALUES (?,?,?,?,?,?)`);
    override.run('account', user.id, 'releasesPerProject', 80, user.id, now);
    override.run('workspace', organizationId, 'releasesPerProject', 90, user.id, now);
    const overridden = await fixture.read();
    assert.equal(overridden.limits.releasesPerProject, 80);
    assert.ok(overridden.projects.every(project => project.releases.limit === 90));
    database.prepare('DELETE FROM clank_platform_quota_overrides WHERE scope_type=? AND scope_id=?')
      .run('workspace', organizationId);
    assert.ok((await fixture.read()).projects.every(project => project.releases.limit === 80));
    database.prepare('DELETE FROM clank_platform_quota_overrides WHERE scope_type=? AND scope_id=?')
      .run('account', user.id);
    database.prepare('UPDATE clank_platform_billing_accounts SET quota_snapshot=? WHERE account_id=?')
      .run(JSON.stringify({ releasesPerProject: 60 }), user.id);
    const changed = await fixture.read();
    assert.ok(changed.projects.every(project => project.releases.limit === 60));
    assert.equal(changed.projects[0].buckets.objectLimit, initial.projects[0].buckets.objectLimit);
    database.prepare('DELETE FROM clank_platform_billing_accounts WHERE account_id=?').run(user.id);
    assert.equal((await fixture.read()).projects[0].releases.limit, initial.projects[0].releases.limit);
  } finally { await fixture.close(); }
});
