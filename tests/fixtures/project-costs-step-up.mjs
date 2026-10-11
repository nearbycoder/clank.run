import {generateKeyPairSync,createHash,sign,randomUUID} from 'node:crypto';
export async function stepUpProjectCosts(f) {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),key='cost-key-'+randomUUID(),id=Buffer.from(key).toString('base64url');
  // Owned fixture enrollment only. AuthServer verifies a fresh UV assertion.
  // This is native authorization proof, not browser/device certification.
  f.db.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(key,id,f.owner.user.id,'Cost fixture enrollment',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const started=await f.call('/__clank/auth/reauthenticate/passkey/start',{}),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:started.options.challenge,origin:f.options.publicUrl,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:started.challengeId,challenge:started.options.challenge,credential:{id,rawId:id,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}}});
}
