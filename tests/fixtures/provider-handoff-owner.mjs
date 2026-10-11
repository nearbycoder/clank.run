import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {providerDockerClient} from '../../dist/provider-docker-client.js';
import {acquireProviderServiceOwnership,createProviderHandoffDomain,initializeProviderHandoff,installProviderHandoffProject,insertProviderHandoffBarrier} from '../../dist/provider-handoff.js';
const [root,executable,log,boundary]=process.argv.slice(2),owner=await acquireProviderServiceOwnership(root,true);
const client=providerDockerClient({executable,dockerEnvironment:{DAEMON:'daemon_original',COMMAND_LOG:log}}),domain=await createProviderHandoffDomain(owner,client,'node_source','owner-original');
const realSync=fs.fsyncSync;
fs.fsyncSync=function(fd){realSync(fd);const path=fs.readlinkSync('/proc/self/fd/'+fd);let stage=null;
 if(path.endsWith('/.writer.sqlite'))stage='marker';
 else if(path.endsWith('/index.sqlite')){const db=new DatabaseSync(path,{readOnly:true});try{const rows=db.prepare('SELECT installation FROM clank_provider_handoff_projects').all();stage=rows.length===0?'index':rows[0].installation;}finally{db.close();}}
 else if(path.endsWith('/catalog.sqlite')){const db=new DatabaseSync(path,{readOnly:true});try{stage=db.prepare('SELECT COUNT(*) AS n FROM clank_provider_handoff_barrier').get().n?'barrier':'catalog';}finally{db.close();}}
 if(stage===boundary){process.send({boundary:stage});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
};
syncBuiltinESMExports();
await initializeProviderHandoff(owner,domain);await installProviderHandoffProject(owner,domain,'project_handoff_01');
await insertProviderHandoffBarrier(owner,domain,'project_handoff_01',{identity:{handoffId:'handoff_01',source:{projectId:'project_handoff_01',nodeId:'node_source',releaseId:'release_source',generation:1},targetNodeId:'node_target',targetGeneration:2,artifactSha256:'a'.repeat(64)},stepId:'step_stop',sourceCapsuleSha256:'b'.repeat(64),sourceIncarnation:'12345678-1234-4123-8123-123456789abc'});
owner.close();throw new Error('Expected metadata boundary was not reached.');
