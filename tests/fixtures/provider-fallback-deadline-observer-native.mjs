// Opt-in independent native acceptance observer; never grants product authority.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {providerDockerClient,runProviderDockerClient} from '../../dist/provider-docker-client.js';
const [controlPath,operationId,owner,projectId,configDirectory,output]=process.argv.slice(2);
const began=process.hrtime.bigint(),bootstrapUntil=began+35000000000n;
const client=providerDockerClient({dockerEnvironment:{DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:configDirectory}});
let db,deadline,failure,phase;const samples=[],processes=new Map(),expected=new Map(),seen=new Set(),started=new Set();
const command=async args=>(await runProviderDockerClient(client,args,{timeoutMs:1500,maxOutputBytes:1024*1024})).stdout;
const birth=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).trim().split(/\s+/u)[19];};
try{
 db=new DatabaseSync(controlPath,{readOnly:true});db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=100');fs.writeFileSync(output+'.ready','ready',{mode:0o600});
 for(;;){
  {const row=db.prepare('SELECT journal FROM clank_deployment_fallback_journals WHERE operation_id=?').get(operationId);if(row){const journal=JSON.parse(row.journal);deadline=BigInt(journal.deadline);phase=journal.phase;for(const role of journal.target?.roles??journal.launchIntent?.roles??[])expected.set(role.containerId,role);}}
  const now=process.hrtime.bigint();if(now>(deadline??bootstrapUntil)+5000000000n)break;
  const ids=(await command(['container','ls','--all','--no-trunc','--filter','label=run.clank.owner='+owner,'--filter','label=run.clank.project='+projectId,'--format','{{.ID}}'])).trim().split('\n').filter(Boolean);
  if(ids.length>34||ids.some(id=>!/^([a-f0-9]{64})$/u.test(id)))throw Error('Independent target inventory exceeds its native bound.');
  for(const cid of ids){
   let rows;try{rows=JSON.parse(await command(['container','inspect',cid]));}catch(error){const remaining=(await command(['container','ls','--all','--no-trunc','--format','{{.ID}}'])).trim().split('\n');if(!remaining.includes(cid))continue;throw error;}const row=rows[0];if(rows.length!==1||row.Id!==cid)throw Error('Independent container identity changed.');seen.add(cid);
   if(row.State.Pid>0){try{const pid=row.State.Pid,cgroup='/sys/fs/cgroup'+fs.readFileSync('/proc/'+pid+'/cgroup','utf8').trim().slice(3);processes.set(cid,{containerId:cid,pid,birth:birth(pid),cgroup});started.add(cid);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  const alive=[];
  if(expected.size){
   const pids=fs.readdirSync('/proc').filter(name=>/^[1-9][0-9]*$/u.test(name));if(pids.length>65536)throw Error('Independent native process inventory exceeds its bound.');
   for(const pid of pids){let groups;try{groups=fs.readFileSync('/proc/'+pid+'/cgroup','utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}if(groups.length>4096)throw Error('Independent cgroup observation exceeds its bound.');
    for(const cid of expected.keys())if(groups.split('\n').some(group=>group.endsWith('/docker/'+cid)||group.endsWith('/docker-'+cid+'.scope'))){if(!alive.includes(cid))alive.push(cid);try{const group=groups.trim();processes.set(cid,{containerId:cid,pid:Number(pid),birth:birth(pid),cgroup:'/sys/fs/cgroup'+group.slice(3)});started.add(cid);}catch(error){if(error.code!=='ENOENT')throw error;}}
   }
  }
  for(const [cid,role] of expected){for(const cgroup of [role.cgroup,'/sys/fs/cgroup/system.slice/docker-'+cid+'.scope','/sys/fs/cgroup/docker/'+cid].filter(Boolean)){try{if(fs.readFileSync(cgroup+'/cgroup.procs','utf8').trim()&&!alive.includes(cid))alive.push(cid);}catch(error){if(error.code!=='ENOENT')throw error;}}}
  for(const value of processes.values()){
   try{if(birth(value.pid)===value.birth)alive.push(value.containerId);}catch(error){if(error.code!=='ENOENT')throw error;}
   try{if(fs.readFileSync(value.cgroup+'/cgroup.procs','utf8').trim()&&!alive.includes(value.containerId))alive.push(value.containerId);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  samples.push({at:process.hrtime.bigint().toString(),ids,alive});
  fs.writeFileSync(output+'.progress.tmp',JSON.stringify({observedStartedIds:[...started]}),{mode:0o600});fs.renameSync(output+'.progress.tmp',output+'.progress');
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 if(!deadline)throw Error('No original signed transfer deadline was observed.');
 if(phase==='prepared'&&started.size===0)throw Error('Prepared target launch was never independently observed.');
 if(phase==='launching'&&expected.size===0)throw Error('No full launch roster was observed.');
 const before=samples.filter(sample=>BigInt(sample.at)<=deadline),last=before.at(-1);
 if(!last||deadline-BigInt(last.at)>1500000000n||last.ids.length||last.alive.length||samples.filter(sample=>BigInt(sample.at)>BigInt(last.at)).some(sample=>sample.ids.length||sample.alive.length))throw Error('Target role absence was not independently observed by the original transfer deadline.');
}catch(error){failure=error;}
finally{
 db?.close();const proof={complete:!failure,originalDeadline:deadline?.toString(),phase,expectedRoleIds:[...expected.keys()],observedContainerIds:[...seen],observedStartedIds:[...started],classification:expected.size?(started.size?'started-target-cleanup':'never-started-target-refusal'):'early-no-target-launch',observedProcesses:[...processes.values()],samples,failure:failure?.message};
 fs.writeFileSync(output,JSON.stringify(proof)+'\n',{mode:0o600});const fd=fs.openSync(output,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(failure)process.exitCode=1;
}
