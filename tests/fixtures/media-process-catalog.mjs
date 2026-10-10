import {join} from 'node:path';
import {defineDatabase,openSQLite} from '../../dist/backend.js';
import {defineAuth,openAuth} from '../../dist/auth.js';
import {defineBucket,openBucketManager} from '../../dist/buckets.js';
import {openLocalObjectStore} from '../../dist/object-storage.js';
import {openMediaProcessing} from '../../dist/media-processing.js';

export async function openMediaCatalog(root,provider,onGarbage) {
  const database=await openSQLite(defineDatabase({}),{path:join(root,'catalog.sqlite'),changePollIntervalMs:0});
  const auth=await openAuth(defineAuth({password:{cost:1024,maxMemory:4*1024*1024}}),database);
  const local=await openLocalObjectStore({directory:join(root,'objects'),maxObjectBytes:4096});
  const buckets=await openBucketManager({definitions:[defineBucket({name:'media',ownership:'user',allowedContentTypes:['text/plain'],maxObjectBytes:4096,maxBytes:16384})],
    databasePath:join(root,'catalog.sqlite'),stagingDirectory:join(root,'staging'),signingKey:'media-process-fixture-private-signing-32bytes',store:onGarbage?{...local,async delete(key){await onGarbage(key);return local.delete(key);}}:local});
  const processing=await openMediaProcessing({database,auth,buckets,policyRevision:1,maxAttempts:3,
    authorize(caller){caller.requireRole('user');},transforms:[{name:'uppercase',revision:'native-provider-1',sourceBucket:'media',destinationBucket:'media',maxInputBytes:4096,maxOutputBytes:4096,
      async handler({source,signal,operationKey,progress}) {
        progress(20);
        const response=await fetch(provider+'/transform',{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({operationKey,base64:Buffer.from(source.bytes).toString('base64')})});
        if(!response.ok)throw new Error('Owned provider refused operation.');const value=await response.json();return {bytes:Buffer.from(value.base64,'base64'),contentType:'text/plain'};
      },
    }]});
  return {database,auth,buckets,processing,close(){processing.close();auth.close();buckets.close();database.close();}};
}
