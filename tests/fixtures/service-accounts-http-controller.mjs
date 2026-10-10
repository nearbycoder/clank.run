// Owned native HTTP controller. A successful rotation commits before its body
// is held so the parent can kill this exact process before network delivery.
import {createHash} from 'node:crypto';
import {openPlatform} from '../../dist/platform.js';
import {serve} from '../../dist/node.js';
let platform;
const server=await serve(async request=>{
  const response=await platform.handle(request);
  if(request.headers.get('x-clank-fixture-hold')==='after-commit'&&request.method==='POST'&&new URL(request.url).pathname.endsWith('/credentials')&&response.status===201){
    const {issued}=await response.clone().json();
    process.send({committed:true,id:issued.credential.id,version:issued.account.version,secretHash:createHash('sha256').update(issued.accessToken).digest('hex')});
    await new Promise(()=>{});
  }
  return response;
},{hostname:'127.0.0.1',port:0});
const url=`http://127.0.0.1:${server.port}`;
platform=await openPlatform({...JSON.parse(process.argv[2]),publicUrl:url});
process.on('message',message=>{if(message.close)void(async()=>{await server.close();await platform.close();process.exit(0);})();});
process.send({ready:true,url});
