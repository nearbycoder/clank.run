import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {defineAuth,openAuth} from '../../dist/auth.js';
import {defineDatabase,openSQLite} from '../../dist/backend.js';
import {openOrganizationSecurityPolicies} from '../../dist/organization-security-policy.js';

export const native=Symbol.for('clank.sqlite.internal'), company='policy_company_01', other='policy_other_02';
export const defaults={factor:'none',ssoOnly:false,sessionMaxAgeMs:30*86400000,enrollmentGraceMs:0};
export async function fixture(t,overrides={}) {
  const root=await mkdtemp(join(tmpdir(),'clank-organization-policy-')),path=join(root,'control.sqlite');
  const db=await openSQLite(defineDatabase({}),{path}),sql=db[native]; let lastCode,rejectAudit=false,now;
  const definition=defineAuth({password:{cost:1024,maxMemory:4*1024*1024},mfa:{send(message){lastCode=message;}}}),auth=await openAuth(definition,db);
  sql.exec(`CREATE TABLE policy_test_members(organization TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(organization,user_id));
    CREATE TABLE policy_test_audit(action TEXT,actor TEXT,organization TEXT,metadata TEXT);`);
  const request=(path,account,body)=>new Request('http://127.0.0.1:42421'+path,{method:body===undefined?'GET':'POST',headers:{origin:'http://127.0.0.1:42421',...(account?{cookie:account.cookie,'x-clank-csrf':account.csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const account=async email=>{
    const response=await auth.handle(request('/auth/register',null,{email,password:'correct horse battery staple'}),'/auth');assert.equal(response.status,201);
    const value=await response.json();return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:value.csrfToken,user:value.user,session:value.session};
  };
  const owner=await account('policy-owner@example.test'),operator=await account('policy-operator@example.test'),target=await account('policy-recovery-owner@example.test');
  const grant=(organization,account,role='owner')=>{sql.prepare('INSERT OR REPLACE INTO policy_test_members VALUES(?,?,?,?)').run(organization,account.user.id,role,Date.now());};
  grant(company,owner);grant(other,owner); now=Date.now();
  const hooks={membership(organization,userId){const row=sql.prepare('SELECT * FROM policy_test_members WHERE organization=? AND user_id=?').get(organization,userId);return row?{role:row.role,createdAt:row.created_at}:null;},
    members(organization){return sql.prepare('SELECT * FROM policy_test_members WHERE organization=? ORDER BY user_id').all(organization).map(row=>({userId:row.user_id,membership:{role:row.role,createdAt:row.created_at}}));},
    exists:organization=>[company,other].includes(organization),audit(actor,organization,action,metadata){if(rejectAudit)throw new Error('Test audit refused.');sql.prepare('INSERT INTO policy_test_audit VALUES(?,?,?,?)').run(action,actor,organization,JSON.stringify(metadata));},now:()=>now,...overrides};
  const controller=openOrganizationSecurityPolicies(db,auth,hooks);
  t.after(async()=>{controller.close();auth.close();db.close();await rm(root,{recursive:true,force:true});});
  const caller=account=>auth.resolve(request('/auth/session',account));
  const step=async(account=owner)=>{
    const start=await auth.handle(request('/auth/reauthenticate/mfa/start',account,{password:'correct horse battery staple'}),'/auth');assert.equal(start.status,200,await start.clone().text());
    const {challengeId}=await start.json();
    const finish=await auth.handle(request('/auth/reauthenticate/mfa/finish',account,{challengeId,code:lastCode.code}),'/auth');assert.equal(finish.status,200,await finish.clone().text());return caller(account);
  };
  const passkey=async(account=target)=>{
    const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),credentialId=Buffer.from('policy-key-'+account.user.id).toString('base64url');
    // Enroll only a real public key; actual UV signature establishes session assurance.
    sql.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run('pk_'+account.user.id,credentialId,account.user.id,'Policy fixture',JSON.stringify(publicKey.export({format:'jwk'})),JSON.stringify(['internal']),Date.now());
    const start=await auth.handle(request('/auth/reauthenticate/passkey/start',account,{}),'/auth');assert.equal(start.status,200);const {challengeId,options}=await start.json();
    const clientData=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin:'http://127.0.0.1:42421'})),data=Buffer.alloc(37);createHash('sha256').update(options.rpId).digest().copy(data);data[32]=5;data.writeUInt32BE(1,33);
    const signature=sign('sha256',Buffer.concat([data,createHash('sha256').update(clientData).digest()]),privateKey);
    const finish=await auth.handle(request('/auth/reauthenticate/passkey/finish',account,{challengeId,challenge:options.challenge,credential:{id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:clientData.toString('base64url'),authenticatorData:data.toString('base64url'),signature:signature.toString('base64url')}}}),'/auth');assert.equal(finish.status,200,await finish.clone().text());return caller(account);
  };
  return {db,sql,auth,definition,path,hooks,controller,owner,operator,target,grant,caller,step,passkey,request,set now(value){now=value;},get now(){return now;},set rejectAudit(value){rejectAudit=value;}};
}
