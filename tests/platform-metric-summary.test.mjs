import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPlatform } from '../dist/platform.js';

test('dashboard summaries match detailed metrics at boundaries with one metric scan per project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'clank-metric-summary-'));
  const platform = await openPlatform({ dataDirectory: root, signup: true,
    publicUrl: 'http://127.0.0.1:4200', backups: { intervalMs: false } });
  const db = new DatabaseSync(join(root, 'control.sqlite'));
  try {
    const response = await platform.handle(new Request('http://127.0.0.1:4200/__clank/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4200' },
      body: JSON.stringify({ email: 'summary@example.invalid', password: 'synthetic-password' }),
    }));
    assert.equal(response.status, 201);
    const { user } = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    const now = Math.floor(Date.now() / 60000) * 60000;
    t.mock.method(Date, 'now', () => now);
    db.prepare(`INSERT INTO clank_platform_organizations(id,name,slug,created_by,created_at,updated_at)
      VALUES ('summary-org','summary','summary-project',?,?,?)`).run(user.id,now,now);
    db.prepare('INSERT INTO clank_platform_memberships VALUES (?,?,?,?,?)').run('summary-org',user.id,'owner',now,now);
    db.prepare(`INSERT INTO clank_platform_projects(id,owner_id,organization_id,name,slug,port,created_at,updated_at)
      VALUES ('summary-project',?,'summary-org','summary','summary',12000,?,?)`).run(user.id, now, now);
    const insert = db.prepare(`INSERT INTO clank_platform_metrics
      (project_id,bucket_started_at,request_count,error_count,status_2xx,status_3xx,status_4xx,status_5xx,
       duration_sum_ms,duration_max_ms,latency_le_50,latency_le_100,latency_le_250,latency_le_500,
       latency_le_1000,latency_le_2500,latency_le_5000,latency_inf,request_bytes,response_bytes,method_get,method_post)
      VALUES ('summary-project',?,100,4,90,6,2,2,12000,400,20,60,80,100,100,100,100,100,1234,5678,70,30)`);
    for (const minute of [0,1,2,15,16,30,1439,1440,1441,2880]) insert.run(now - minute * 60000);
    const read = async path => {
      const result = await platform.handle(new Request('http://127.0.0.1:4200'+path, { headers: { cookie } }));
      assert.equal(result.status,200); return result.json();
    };
    const compare = async () => {
      const detailed = await read('/api/projects/summary-project/metrics?range=24h');
      const proto = Object.getPrototypeOf(db.prepare('SELECT 1')), all = proto.all, get = proto.get;
      let scans = 0;
      const wrap = original => function(...args) {
        if (/FROM clank_platform_metrics\b/.test(this.sourceSQL)) scans++;
        return original.apply(this,args);
      };
      const a = t.mock.method(proto,'all',wrap(all)), b = t.mock.method(proto,'get',wrap(get));
      const dashboard = await read('/api/dashboard'); a.mock.restore(); b.mock.restore();
      assert.deepEqual(dashboard.projects[0].metrics,detailed.summary);
      assert.equal(scans,1,'Overview must not build charts or scan a discarded previous period');
      return detailed.summary;
    };
    assert.equal((await compare()).requests,800);
    db.prepare("INSERT INTO clank_platform_metrics(project_id,bucket_started_at) VALUES ('summary-project',?)").run(now+1);
    await compare();
    db.exec('DELETE FROM clank_platform_metrics');
    assert.equal((await compare()).requests,0);
    db.prepare("INSERT INTO clank_platform_metrics(project_id,bucket_started_at) VALUES ('summary-project',?)").run(now);
    const empty = await compare(); assert.equal(empty.activeIntervals,0); assert.equal(empty.lastRequestAt,now);
  } finally { db.close(); await platform.close(); await rm(root,{recursive:true,force:true}); }
});

test('platform rejects unbounded password admission before opening storage', async () => {
  for (const authentication of [{concurrency:0},{concurrency:17},{maxQueue:0},{maxQueue:129}]) {
    await assert.rejects(openPlatform({dataDirectory:'/unused',authentication}),/authentication/);
  }
});
