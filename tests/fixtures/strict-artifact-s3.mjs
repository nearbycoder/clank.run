import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { open,readFile,writeFile,rename,rm } from 'node:fs/promises';
import { openLocalObjectStore } from '../../dist/object-storage.js';

/** Native HTTP fixture. Hooks run only on the server, never in the branded client. */
export async function openStrictArtifactS3(root) {
  const nativeStore = await openLocalObjectStore({directory:root,maxObjectBytes:100*1024*1024});
  const hooks = {}, requests = [], active = new Set(), sockets = new Set(), records = new WeakMap(), writers = new Map();
  const sync = async path => {const handle=await open(path,'r');try{await handle.sync()}finally{await handle.close()}};
  const location = key => {const digest=createHash('sha256').update(key).digest('hex');return{file:join(root,'objects',digest.slice(0,2),digest+'.object'),shard:join(root,'objects',digest.slice(0,2))}};
  const metadataHeaders = (res,metadata) => {
    res.setHeader('content-type',metadata.contentType);res.setHeader('content-length',metadata.size);
    res.setHeader('x-amz-meta-clank-created-at',metadata.createdAt);res.setHeader('x-amz-meta-clank-updated-at',metadata.updatedAt);
    res.setHeader('x-amz-meta-clank-sha256',metadata.sha256);
  };
  const serve = async(req,res) => {
    const parts=new URL(req.url,'http://localhost').pathname.split('/').slice(2).map(decodeURIComponent),key=parts.join('/');
    const record={method:req.method,path:req.url,key,headers:{...req.headers},status:null,bytes:0};requests.push(record);records.set(req,record);
    res.on('finish',()=>{record.status=res.statusCode});
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024){res.writeHead(413);res.end();return}chunks.push(chunk)}
    const bytes=Buffer.concat(chunks);record.bytes=bytes.length;
    if(!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization??'')||req.headers['x-amz-content-sha256']!==createHash('sha256').update(bytes).digest('hex')){res.writeHead(403);res.end();return}
    const before=await hooks.before?.({request:req,response:res,record,bytes});
    if(before==='destroy'){res.destroy();return}
    if(before){res.writeHead(before.status??500,before.headers??{});res.end(before.body??'');return}
    const metadataPath=location(key).file+'.s3-meta';
    const read=async()=>{
      const stored=await nativeStore.get(key);if(!stored)return null;
      try{return {...stored,metadata:JSON.parse(await readFile(metadataPath,'utf8'))}}
      catch(error){if(error.code!=='ENOENT')throw error;return stored}
    };
    const remove=async()=>{const removed=await nativeStore.delete(key);await rm(metadataPath,{force:true});if(removed)await sync(location(key).shard);return removed};
    if(req.method==='PUT'){
      if(req.headers['if-none-match']==='*'&&await nativeStore.stat(key)){res.writeHead(412);res.end();return}
      const commit=async()=>{
        const previous=writers.get(key)??Promise.resolve();
        const work=previous.catch(()=>{}).then(async()=>{
          if(req.headers['if-none-match']==='*'&&await nativeStore.stat(key)){const error=new Error('Conditional object already exists');error.status=412;throw error}
          const actual=await nativeStore.put(key,bytes,{contentType:String(req.headers['content-type']??'application/octet-stream')});
          const metadata={...actual,createdAt:Number(req.headers['x-amz-meta-clank-created-at']),updatedAt:Number(req.headers['x-amz-meta-clank-updated-at']),sha256:String(req.headers['x-amz-meta-clank-sha256'])};
          if(!Number.isSafeInteger(metadata.createdAt)||metadata.createdAt<0||!Number.isSafeInteger(metadata.updatedAt)||metadata.updatedAt<0||metadata.sha256!==actual.sha256)throw new Error('Invalid supplied S3 object metadata');
          const temporary=metadataPath+'.'+crypto.randomUUID()+'.tmp';
          try{await writeFile(temporary,JSON.stringify(metadata),{flag:'wx',mode:0o600});await sync(temporary);await rename(temporary,metadataPath)}finally{await rm(temporary,{force:true})}
          const paths=location(key);await sync(paths.file);await sync(paths.shard);await sync(join(root,'objects'));await sync(root);
          return metadata;
        });
        writers.set(key,work);
        try{return await work}finally{if(writers.get(key)===work)writers.delete(key)}
      };
      const metadata=hooks.put?await hooks.put(key,bytes,{contentType:req.headers['content-type']},commit):await commit();
      await hooks.after?.({request:req,response:res,record,metadata});
      if(!res.destroyed&&!res.writableEnded){res.writeHead(200);res.end()}
    }else if(req.method==='GET'||req.method==='HEAD'){
      const stored=hooks.get?await hooks.get(key,read):await read();
      if(!stored){res.writeHead(404);res.end();return}
      metadataHeaders(res,stored.metadata);res.writeHead(200);res.end(req.method==='HEAD'?undefined:stored.bytes);
    }else if(req.method==='DELETE'){
      if(hooks.delete)await hooks.delete(key,remove);else await remove();res.writeHead(204);res.end();
    }else{res.writeHead(405);res.end()}
  };
  const server=createServer((req,res)=>{const work=serve(req,res).catch(error=>{records.get(req).error=error.message;if(!res.destroyed){res.writeHead(error.status??500);res.end()}});active.add(work);void work.finally(()=>active.delete(work));});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {endpoint:`http://127.0.0.1:${server.address().port}`,nativeStore,hooks,requests,
    async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...active]);}};
}
