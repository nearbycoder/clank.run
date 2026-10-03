import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { openPlatform } from '../dist/platform.js';
import { dashboardFixture } from '../scripts/load/performance-platform.mjs';

const origin = 'http://127.0.0.1:4200';

async function inspectReads(t, database, operation) {
  const reads = [], prototype = Object.getPrototypeOf(database.prepare('SELECT 1'));
  const spies = ['all', 'get'].map(name => {
    const original = prototype[name];
    return t.mock.method(prototype, name, function (...parameters) {
      reads.push({ sql: this.sourceSQL, parameters });
      return original.apply(this, parameters);
    });
  });
  try { return { result: await operation(), reads }; }
  finally { for (const spy of spies) spy.mock.restore(); }
}

async function projectList(fixture, path, headers = { cookie: fixture.cookie }) {
  const response = await fixture.runtime.handle(new Request(`${origin}${path}`, { headers }));
  assert.equal(response.status, 200);
  return response.json();
}

test('project enumeration reads current roles and overrides once, including scoped preview inheritance', async t => {
  const fixture = await dashboardFixture(openPlatform, { projects: 10 });
  const { database, user, organizationId } = fixture;
  try {
    const restricted = 'dashboard-project-0', parent = 'dashboard-project-1';
    const changeRole = database.prepare('UPDATE clank_platform_memberships SET role=? WHERE organization_id=? AND user_id=?');
    const override = database.prepare(`INSERT INTO clank_platform_project_members(project_id,user_id,permissions)
      VALUES (?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET permissions=excluded.permissions`);
    override.run(restricted, user.id, '["logs"]');
    const read = async (path, expected, headers) => {
      const { result, reads } = await inspectReads(t, database, () => projectList(fixture, path, headers));
      assert.equal(result.projects.length, expected);
      assert.equal(reads.filter(({ sql }) => /SELECT role FROM clank_platform_memberships\b/u.test(sql)
        || /SELECT permissions FROM clank_platform_project_members\b/u.test(sql)).length, 0,
      'Project authority must be resolved by the current indexed lookup, without per-project reads.');
      assert.ok(result.projects.every(project => !('membership_role' in project) && !('project_permissions' in project)));
      return result.projects.map(project => project.id);
    };
    for (const role of ['owner', 'admin', 'developer', 'viewer']) {
      changeRole.run(role, organizationId, user.id);
      for (const path of ['/api/projects', '/api/dashboard']) {
        const projects = await read(path, ['owner', 'admin'].includes(role) ? 10 : 9);
        assert.equal(projects.includes(restricted), ['owner', 'admin'].includes(role));
      }
    }
    override.run(restricted, user.id, '["read"]');
    for (const path of ['/api/projects', '/api/dashboard']) await read(path, 10);
    override.run(restricted, user.id, '["logs"]');
    for (const path of ['/api/projects', '/api/dashboard']) await read(path, 9);
    database.prepare('DELETE FROM clank_platform_project_members WHERE project_id=?').run(restricted);
    for (const path of ['/api/projects', '/api/dashboard']) await read(path, 10);

    // Stored malformed restrictions fail closed for ordinary members; owner/admin bypass remains unchanged.
    for (const invalid of ['null', '{"read":true}', '["unknown-permission"]']) {
      override.run(restricted, user.id, invalid);
      for (const path of ['/api/projects', '/api/dashboard']) {
        assert.equal((await fixture.runtime.handle(new Request(`${origin}${path}`, { headers: { cookie: fixture.cookie } }))).status, 500);
      }
    }
    changeRole.run('admin', organizationId, user.id);
    for (const path of ['/api/projects', '/api/dashboard']) await read(path, 10);
    changeRole.run('viewer', organizationId, user.id);
    database.prepare('DELETE FROM clank_platform_project_members WHERE project_id=?').run(restricted);

    const now = Date.now(), preview = 'performance-preview', token = `clnk_${randomBytes(32).toString('base64url')}`;
    database.prepare(`INSERT INTO clank_platform_projects
      (id,owner_id,organization_id,name,slug,port,parent_project_id,created_at,updated_at)
      VALUES (?,?,?,?,?,14000,?,?,?)`).run(preview, user.id, organizationId, preview, preview, parent, now, now);
    database.prepare(`INSERT INTO clank_platform_tokens
      (id,token_hash,user_id,name,created_at,expires_at,organization_id,project_id,permissions)
      VALUES (?,?,?,'Synthetic test token',?,?,?,?,?)`).run('performance-token',
      createHash('sha256').update(token).digest('base64url'), user.id, now, now + 60000,
      organizationId, preview, '["read"]');
    const authorization = { authorization: `Bearer ${token}` };
    override.run(parent, user.id, '["logs"]');
    override.run(preview, user.id, '["read"]');
    for (const path of ['/api/projects', '/api/dashboard']) await read(path, 0, authorization);
    override.run(parent, user.id, '["read"]');
    for (const path of ['/api/projects', '/api/dashboard']) assert.deepEqual(await read(path, 1, authorization), [preview]);
    // Workspace revocation wins over explicit project access on the very next request.
    database.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run(organizationId, user.id);
    for (const path of ['/api/projects', '/api/dashboard']) await read(path, 0, authorization);
    database.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE id=?').run(Date.now(), 'performance-token');
    assert.equal((await fixture.runtime.handle(new Request(`${origin}/api/projects`, { headers: authorization }))).status, 401);
  } finally { await fixture.close(); }
});

test('dashboard domain and release summaries use two indexed reads for only authorized projects', async t => {
  const fixture = await dashboardFixture(openPlatform, { projects: 40, metricBuckets: 3 });
  const { database, user, organizationId } = fixture;
  try {
    const now = Date.now();
    const domain = database.prepare(`INSERT INTO clank_platform_domains
      (id,project_id,hostname,record_name,record_value,status,routing_status,expires_at,created_at)
      VALUES (?,?,?,'_clank','synthetic',?,?,?,?)`);
    const release = database.prepare(`INSERT INTO clank_platform_releases
      (id,project_id,status,digest,artifact_bytes,storage_bytes,artifact_available,framework_version,node_version,
       config,directory,idempotency_key,created_at)
      VALUES (?,?,'active','synthetic',100,?,?,'0.0.0','v22','{}','synthetic',?,?)`);
    database.exec('BEGIN');
    for (let index = 0; index < 40; index++) {
      const project = `dashboard-project-${index}`;
      for (const [suffix, status, routing] of [['ready', 'verified', 'ready'], ['misconfigured', 'verified', 'misconfigured'], ['pending', 'pending', 'ready']]) {
        const id = `${project}-${suffix}`;
        domain.run(id, project, `${id}.example.invalid`, status, routing, now + 60000, now);
      }
      for (const [suffix, bytes, available] of [['first', index + 1, 1], ['second', index + 2, 1], ['pruned', 999, 0]]) {
        const id = `${project}-${suffix}`;
        release.run(id, project, bytes, available, id, now);
      }
    }
    database.exec('COMMIT');
    // The denied project still has stored metrics/domains/releases, but no aggregate may read it.
    database.prepare('UPDATE clank_platform_memberships SET role=? WHERE organization_id=? AND user_id=?')
      .run('viewer', organizationId, user.id);
    database.prepare('INSERT INTO clank_platform_project_members VALUES (?,?,?)')
      .run('dashboard-project-0', user.id, '["logs"]');
    const check = async expectedProjects => {
      const { result, reads } = await inspectReads(t, database, () => fixture.read());
      assert.equal(result.projects.length, expectedProjects);
      const summaries = reads.filter(({ sql }) => /FROM clank_platform_(?:domains|releases)\b/u.test(sql));
      assert.equal(summaries.length, expectedProjects ? 2 : 0);
      for (const { sql, parameters } of summaries) {
        assert.deepEqual(JSON.parse(parameters[0]).sort(), result.projects.map(project => project.id).sort());
        const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map(row => row.detail).join('\n');
        assert.match(plan, /SEARCH clank_platform_(?:domains|releases) USING INDEX clank_platform_(?:domains|releases)_project/u);
        assert.doesNotMatch(plan, /SCAN clank_platform_(?:domains|releases)\b/u);
      }
      for (const project of result.projects) {
        const expectedDomains = database.prepare(`SELECT count(*) AS count,
          sum(CASE WHEN status='verified' AND routing_status='ready' THEN 1 ELSE 0 END) AS ready
          FROM clank_platform_domains WHERE project_id=?`).get(project.id);
        const expectedReleases = database.prepare(`SELECT
          sum(CASE WHEN artifact_available=1 THEN 1 ELSE 0 END) AS releases,
          sum(CASE WHEN artifact_available=1 THEN storage_bytes ELSE 0 END) AS storageBytes
          FROM clank_platform_releases WHERE project_id=?`).get(project.id);
        assert.equal(project.domains.count, expectedDomains.count);
        assert.equal(project.domains.ready, expectedDomains.ready ?? 0);
        assert.equal(project.releases.releases, expectedReleases.releases ?? 0);
        assert.equal(project.releases.storageBytes, expectedReleases.storageBytes ?? 0);
        assert.equal(project.metrics.requests, 180);
      }
      assert.equal(result.totals.requests, expectedProjects * 180);
      return result;
    };
    await check(39);
    database.prepare('DELETE FROM clank_platform_domains WHERE project_id=?').run('dashboard-project-1');
    database.prepare('DELETE FROM clank_platform_releases WHERE project_id=?').run('dashboard-project-1');
    const empty = (await check(39)).projects.find(project => project.id === 'dashboard-project-1');
    assert.equal(empty.domains.count, 0);
    assert.equal(empty.releases.storageBytes, 0);
    database.prepare(`INSERT INTO clank_platform_project_members(project_id,user_id,permissions)
      SELECT id,?,'["logs"]' FROM clank_platform_projects WHERE organization_id=?
      ON CONFLICT(project_id,user_id) DO UPDATE SET permissions=excluded.permissions`).run(user.id, organizationId);
    await check(0);
  } finally { await fixture.close(); }
});
