import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPlatform } from '../dist/platform.js';

test('project lists use indexed tenant lookups without changing membership, ownership fallback, or preview visibility', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clank-tenant-lookups-'));
  let platform = await openPlatform({ dataDirectory: root, publicUrl: 'http://127.0.0.1:4200', signup: true,
    backups: { intervalMs: false } });
  const db = new DatabaseSync(join(root, 'control.sqlite'));
  const register = async email => {
    const response = await platform.handle(new Request('http://127.0.0.1:4200/__clank/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4200' },
      body: JSON.stringify({ email, password: 'synthetic-test-password' }),
    }));
    assert.equal(response.status, 201);
    return { ...(await response.json()), cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  try {
    const alice = await register('alice@example.invalid'), bob = await register('bob@example.invalid');
    const now = Date.now();
    const org = db.prepare('INSERT INTO clank_platform_organizations(id,name,slug,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)');
    for (const [id, owner] of [['owned-org', alice.user.id], ['shared-org', bob.user.id], ['hidden-org', bob.user.id]]) {
      org.run(id, id, id, owner, now, now);
      db.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)').run(id, owner, 'owner', now, now);
    }
    db.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)').run('shared-org', alice.user.id, 'viewer', now, now);
    const project = db.prepare(`INSERT INTO clank_platform_projects
      (id,owner_id,organization_id,name,slug,port,parent_project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    let port = 12000;
    const insert = (id, owner, organization, parent = null) => project.run(id, owner, organization, id, id, port++, parent, now, now);
    insert('owned', alice.user.id, 'owned-org');
    insert('shared', bob.user.id, 'shared-org');
    insert('fallback', alice.user.id, 'hidden-org');
    insert('hidden', bob.user.id, 'hidden-org');
    insert('preview', alice.user.id, 'owned-org', 'owned');
    // Large unrelated population must not turn the visible-project lookup into a catalog scan.
    db.exec('BEGIN');
    for (let index = 0; index < 1000; index++) {
      const id = `noise-${index}`;
      db.prepare(`INSERT INTO clank_auth_users(id,email,password_hash,role,profile,created_at,updated_at)
        VALUES (?,?,'unused','user','{}',?,?)`).run(id, `${id}@example.invalid`, now, now);
      org.run(id, id, id, id, now, now);
      db.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)').run(id, id, 'owner', now, now);
      for (let n = 0; n < 3; n++) insert(`${id}-${n}`, id, id);
    }
    db.exec('COMMIT');
    const lookups = [];
    const prototype = Object.getPrototypeOf(db.prepare('SELECT 1')), all = prototype.all;
    const spy = t.mock.method(prototype, 'all', function (...parameters) {
      if (this.sourceSQL.includes('p.parent_project_id IS NULL')) lookups.push({ sql: this.sourceSQL, parameters });
      return all.apply(this, parameters);
    });
    const list = async path => {
      const response = await platform.handle(new Request(`http://127.0.0.1:4200${path}`, { headers: { cookie: alice.cookie } }));
      assert.equal(response.status, 200);
      return (await response.json()).projects.map(row => row.id).sort();
    };
    for (const path of ['/api/projects', '/api/dashboard']) assert.deepEqual(await list(path), ['fallback', 'owned', 'shared']);
    spy.mock.restore();
    assert.equal(lookups.length, 2);
    for (const lookup of lookups) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`).all(...lookup.parameters).map(row => row.detail).join('\n');
      assert.match(plan, /SEARCH owned USING INDEX clank_platform_projects_owner/);
      assert.match(plan, /SEARCH member USING INDEX clank_platform_projects_org/);
      assert.doesNotMatch(plan, /SCAN (?:p|owned|member)\b/);
    }
    for (const [sql, key, index] of [
      ['SELECT count(*) FROM clank_platform_projects WHERE owner_id = ?', alice.user.id, 'clank_platform_projects_owner'],
      ['SELECT id FROM clank_platform_organizations WHERE created_by = ? ORDER BY created_at LIMIT 1', alice.user.id, 'clank_platform_organizations_creator'],
    ]) assert.ok(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(key).some(row => row.detail.includes(index)));
    db.prepare('DELETE FROM clank_platform_memberships WHERE organization_id=? AND user_id=?').run('shared-org', alice.user.id);
    for (const path of ['/api/projects', '/api/dashboard']) assert.deepEqual(await list(path), ['fallback', 'owned']);
    await platform.close();
    platform = await openPlatform({ dataDirectory: root, publicUrl: 'http://127.0.0.1:4200', signup: true,
      backups: { intervalMs: false } });
    assert.deepEqual(await list('/api/projects'), ['fallback', 'owned']);
  } finally { db.close(); await platform.close(); await rm(root, { recursive: true, force: true }); }
});
