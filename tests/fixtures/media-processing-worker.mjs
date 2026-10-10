import {openMediaCatalog} from './media-process-catalog.mjs';
const root=process.env.CLANK_MEDIA_FIXTURE_ROOT,provider=process.env.CLANK_MEDIA_FIXTURE_PROVIDER;
if(!root||!provider||!process.send)throw new Error('Owned media worker fixture configuration is required.');
let environment;
environment=await openMediaCatalog(root,provider,process.env.CLANK_MEDIA_FIXTURE_HOLD==='after-publish'?async()=>{
  const row=environment.database[Symbol.for('clank.sqlite.internal')].prepare('SELECT id,job_id,result FROM clank_media_operations WHERE result IS NOT NULL').get();
  if(!row)throw new Error('Publication was not actually committed before the hold.');
  process.send({kind:'published',operation:row.id,job:row.job_id});await new Promise(()=>{});
}:undefined);
if(process.env.CLANK_MEDIA_FIXTURE_WAIT_FOR_START==='1'){
  const start=new Promise(resolve=>process.once('message',resolve));process.send({kind:'ready'});await start;
}
const worked=await environment.processing.workOnce({workerId:'actual-media-process-worker-'+process.pid,leaseMs:1000});
process.send({kind:'finished',worked});
environment.close();
process.disconnect();
