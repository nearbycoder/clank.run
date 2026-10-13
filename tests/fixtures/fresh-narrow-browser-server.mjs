// A real nested browsing context for narrow layout acceptance when a browser
// viewport override cannot be observed. This does not emulate a phone device.
import {createServer} from 'node:http';
const port=Number(process.argv[2]),targets={attachments:'http://127.0.0.1:42671/',costs:'http://127.0.0.1:42639/',console:'http://localhost:42655/fixture/as/owner',status:'http://127.0.0.1:42647/fixture/as/owner'};
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Supply an owned loopback port.');
const server=createServer((request,response)=>{
 const target=targets[new URL(request.url,'http://127.0.0.1').searchParams.get('target')??'costs'];
 if(!target){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
 response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>390-pixel native browsing context</title><h1>390-pixel native browsing context</h1><p>This is a real narrow iframe viewport in desktop Chrome. It does not certify a physical phone or device emulation.</p><iframe title="Narrow native verification" src="'+target+'" width="390" height="844" style="border:1px solid #666;max-width:100%"></iframe></html>');
});
server.listen(port,'127.0.0.1',()=>console.log('Owned narrow fixture http://127.0.0.1:'+port));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
