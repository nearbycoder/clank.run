// Owned cryptographic UV fixture; this does not certify a physical authenticator.
import {randomUUID,generateKeyPairSync,createHash,sign} from 'node:crypto';
export async function step(f,db,account) {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),key='status-key-'+randomUUID(),credentialId=Buffer.from(key).toString('base64url');
  db.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run(key,credentialId,account.user.id,'Owned UV fixture',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await f.call('/__clank/auth/reauthenticate/passkey/start',{},200,undefined,account),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin:f.options.publicUrl,crossOrigin:false}));
  const data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential:{id:credentialId,rawId:credentialId,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}}},200,undefined,account);
}

