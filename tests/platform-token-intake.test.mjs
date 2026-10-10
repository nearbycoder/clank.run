import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {fixture} from './fixtures/platform-environment-fixture.mjs';

for (const boundary of ['rotated', 'scope-reduced', 'project-rebound', 'revoked', 'expired', 'disabled', 'unchanged']) {
  test(`held native HTTP secret intake fences ${boundary} token authority`, async t => {
    const f = await fixture(t), origin = await f.serve();
    const db = new DatabaseSync(join(f.options.dataDirectory, 'control.sqlite'));
    t.after(() => db.close());
    const token = (await f.call(`/api/projects/${f.development.id}/tokens`, {name:'Held credential fixture',permissions:['read','secrets'],expiresIn:300}, 201)).token;
    const payload = JSON.stringify({values:{INTAKE_FIXTURE:'accepted only by current authority'}});
    const response = new Promise((resolve, reject) => {
      const upload = request(origin + `/api/projects/${f.development.id}/secrets`, {method:'PUT',headers:{authorization:'Bearer '+token.accessToken,'content-type':'application/json','content-length':Buffer.byteLength(payload)}}, incoming => {
        let bytes = '';
        incoming.on('data', chunk => {bytes += chunk;});
        incoming.once('end', () => resolve({status:incoming.statusCode,body:JSON.parse(bytes)}));
        incoming.once('error', reject);
      });
      upload.once('error', reject);upload.setTimeout(5000, () => upload.destroy(new Error('Held fixture timed out.')));
      t.after(() => upload.destroy());
      upload.write(payload.slice(0,1));
      void (async () => {
        const deadline = Date.now()+3000;
        while (db.prepare('SELECT last_used_at FROM clank_platform_tokens WHERE id=?').get(token.id).last_used_at === null) {
          assert.ok(Date.now()<deadline, 'The real listener must authenticate the held headers before the remaining body arrives.');
          await new Promise(resolve => setTimeout(resolve,10));
        }
        if(boundary==='rotated') db.prepare('UPDATE clank_platform_tokens SET token_hash=? WHERE id=?').run(createHash('sha256').update('clnk_'+'r'.repeat(43)).digest('hex'),token.id);
        if(boundary==='scope-reduced') db.prepare('UPDATE clank_platform_tokens SET permissions=? WHERE id=?').run(JSON.stringify(['read']),token.id);
        if(boundary==='project-rebound') db.prepare('UPDATE clank_platform_tokens SET project_id=? WHERE id=?').run(f.staging.id,token.id);
        if(boundary==='revoked') db.prepare('UPDATE clank_platform_tokens SET revoked_at=? WHERE id=?').run(Date.now(),token.id);
        if(boundary==='expired') db.prepare('UPDATE clank_platform_tokens SET expires_at=? WHERE id=?').run(Date.now()-1,token.id);
        if(boundary==='disabled') db.prepare('UPDATE clank_auth_users SET disabled=1 WHERE id=?').run(f.owner.user.id);
        upload.end(payload.slice(1));
      })().catch(error => upload.destroy(error));
    });
    const result = await response, allowed = boundary==='unchanged';
    t.diagnostic(JSON.stringify({boundary,status:result.status,secrets:db.prepare('SELECT count(*) AS n FROM clank_platform_secrets WHERE project_id=? AND name=?').get(f.development.id,'INTAKE_FIXTURE').n,audits:db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE project_id=? AND action='secrets.update'").get(f.development.id).n}));
    assert.equal(result.status,allowed?200:401);
    assert.equal(db.prepare('SELECT count(*) AS n FROM clank_platform_secrets WHERE project_id=? AND name=?').get(f.development.id,'INTAKE_FIXTURE').n,Number(allowed));
    assert.equal(db.prepare("SELECT count(*) AS n FROM clank_platform_audit WHERE project_id=? AND action='secrets.update'").get(f.development.id).n,Number(allowed));
    if(!allowed) assert.equal(result.body.error.code,'INVALID_TOKEN');
    if(boundary==='disabled') db.prepare('UPDATE clank_auth_users SET disabled=0 WHERE id=?').run(f.owner.user.id);
  });
}
