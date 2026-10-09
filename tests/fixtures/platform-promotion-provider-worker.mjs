import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDockerDeploymentProviderService } from '../../dist/provider-service.js';
import { createDeploymentProviderHandler } from '../../dist/provider.js';
import { serve } from '../../dist/node.js';
assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.ok(process.getgroups().every(group=>group===1000));
const status=await readFile('/proc/self/status','utf8');
assert.match(status,/^Groups:[ \t]*$/m);
for(const field of ['CapEff','CapPrm','CapInh','CapBnd','CapAmb'])assert.equal(BigInt('0x'+status.match(new RegExp('^'+field+':\\s+([a-f0-9]+)$','m'))[1]),0x201002n);
assert.match(status,/^NoNewPrivs:\s+1$/m);
let service,server,handler,listenPort;
const listen=async()=>{
  server=await serve(request=>handler.paths.includes(new URL(request.url).pathname)?handler.handle(request):service.handle(request),{hostname:'127.0.0.1',port:listenPort??0,maxBodySize:4*1024*1024});
  listenPort=server.port;
};
let closeFlight;
const close=()=>closeFlight??=(async()=>{await server?.close();await service?.close()})();
process.once('disconnect',()=>{void close().then(()=>process.exit(0),()=>process.exit(72))});
process.once('SIGTERM',()=>{void close().then(()=>process.exit(0),()=>process.exit(72))});
process.on('message',async message=>{
  try{
    let value;
    if(message.method==='open'){
      const config=message.input;await mkdir(join(config.root,'docker-config'),{mode:0o700});
      service=await openDockerDeploymentProviderService({rootDirectory:config.root,owner:config.owner,image:config.profile.image,data:{maxDatabaseBytes:1024*1024},
        docker:{executable:'/usr/bin/docker',dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:join(config.root,'docker-config')},user:config.profile.user,memory:config.profile.memory,cpus:config.profile.cpus,pidsLimit:config.profile.pidsLimit,
          diskQuota:{...config.profile.diskQuota,quotaId:config.quotaId},outboundNetwork:config.profile.outboundNetwork,portStart:57540,portEnd:57560,maxRuntimes:1,maxContainers:1,stopTimeoutMs:1000}});
      handler=createDeploymentProviderHandler(service,{token:config.token,maxArtifactBytes:1024*1024,maxRuntimeBytes:2*1024*1024});
      await listen();value={port:server.port};
    }else if(message.method==='pause-ingress'){await server.close();server=null;value=true}
    else if(message.method==='resume-ingress'){assert.equal(server,null);await listen();value={port:server.port}}
    else if(message.method==='close'){await close();process.send({id:message.id,value:true},()=>process.exit(0));return}
    else throw new Error('Unsupported owned provider operation.');
    process.send({id:message.id,value});
  }catch(error){process.send({id:message.id,error:String(error.stack||error).slice(0,4096)})}
});
