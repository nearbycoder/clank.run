// Owned real HTTP controller: acknowledge a completed CAS to the parent while
// holding only its response body, then permit an actual process kill.
import {openPlatform} from '../../dist/platform.js';
import {serve} from '../../dist/node.js';
let platform;
const server=await serve(async request=>{
  const response=await platform.handle(request);
  if(request.headers.get('x-clank-fixture-hold')==='after-commit' && request.method==='POST' && new URL(request.url).pathname.endsWith('/security-policy') && response.status===200) {
    const {policy}=await response.clone().json();process.send({committed:true,policy});await new Promise(()=>{});
  }
  return response;
},{hostname:'127.0.0.1',port:0});
const url=`http://127.0.0.1:${server.port}`;
platform=await openPlatform({...JSON.parse(process.argv[2]),publicUrl:url});
process.on('message',value=>{if(value.close)void(async()=>{await server.close();await platform.close();process.exit(0);})();});
process.send({ready:true,url});
