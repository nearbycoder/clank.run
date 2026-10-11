import {createHash,generateKeyPairSync,sign} from 'node:crypto';
export async function signedStepUp(f,native){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),id=Buffer.from('recovery-admin-'+f.owner.user.id).toString('base64url');
  // Enroll only a fixture public key. Actual UV ECDSA verification and challenge
  // consumption occur through AuthServer; no session freshness is injected.
  native.prepare('INSERT INTO clank_auth_passkeys(id,credential_id,user_id,name,public_key,algorithm,counter,transports,created_at) VALUES(?,?,?,?,?,-7,0,?,?)').run('recovery-key-'+f.owner.user.id,id,f.owner.user.id,'Recovery fixture key',JSON.stringify(publicKey.export({format:'jwk'})),'[]',Date.now());
  const start=await f.call('/__clank/auth/reauthenticate/passkey/start',{}),client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:start.options.challenge,origin:f.options.publicUrl,crossOrigin:false})),data=Buffer.concat([createHash('sha256').update(new URL(f.options.publicUrl).hostname).digest(),Buffer.from([5,0,0,0,1])]);
  await f.call('/__clank/auth/reauthenticate/passkey/finish',{challengeId:start.challengeId,challenge:start.options.challenge,credential:{id,rawId:id,type:'public-key',response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),userHandle:null}}});
}
