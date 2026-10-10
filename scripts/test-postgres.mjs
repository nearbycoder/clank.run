// Explicit opt-in native PostgreSQL verification. Creates a fresh private
// cluster; never opens, alters or stops an existing PostgreSQL installation.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
const exec=promisify(execFile),repository=fileURLToPath(new URL('..',import.meta.url));
if(process.getuid?.()===0)throw new Error('Run the owned PostgreSQL verifier as an ordinary user.');
if(process.argv.slice(2).some(value=>value!=='--full'))throw new Error('Usage: node scripts/test-postgres.mjs [--full]');
const bindir=process.env.CLANK_TEST_POSTGRES_BINDIR??(await exec('pg_config',['--bindir'])).stdout.trim();
if(!bindir.startsWith('/')||bindir.includes('\0'))throw new Error('An absolute trusted PostgreSQL binary directory is required.');
const root=await mkdtemp(join(tmpdir(),'clank-postgres-contract-')),data=join(root,'data');
const privateRun=async(binary,args)=>{
  try {return await exec(binary,args,{timeout:30000,maxBuffer:1024*1024});}
  catch {throw new Error('Owned PostgreSQL setup/cleanup command failed: '+binary.split('/').at(-1));}
};
const portServer=createServer();await new Promise((resolve,reject)=>{portServer.once('error',reject);portServer.listen(0,'127.0.0.1',resolve);});
const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
let started=false,stopped=false;
try {
  const password=randomBytes(32).toString('base64url');await writeFile(join(root,'password'),password+'\n',{mode:0o600});
  await privateRun(join(bindir,'initdb'),['--no-locale','--encoding=UTF8','--username=clank_contract','--auth-local=trust','--auth-host=scram-sha-256','--pwfile='+join(root,'password'),'-D',data]);
  await privateRun('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-keyout',join(root,'ca-key.pem'),'-out',join(root,'ca.pem'),'-subj','/CN=Owned Clank PostgreSQL test CA']);
  await privateRun('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',join(root,'server-key.pem'),'-out',join(root,'server.csr'),'-subj','/CN=localhost']);
  await writeFile(join(root,'extensions'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',{mode:0o600});
  await privateRun('openssl',['x509','-req','-in',join(root,'server.csr'),'-CA',join(root,'ca.pem'),'-CAkey',join(root,'ca-key.pem'),'-CAcreateserial','-out',join(root,'server.pem'),'-days','1','-sha256','-extfile',join(root,'extensions')]);
  // mkdtemp roots cannot contain SQL/config delimiters. Every certificate and
  // socket path belongs to this exact private cluster.
  if(!/^\/[A-Za-z0-9_./-]+$/u.test(root))throw new Error('Owned PostgreSQL temporary path is unsupported.');
  await writeFile(join(data,'postgresql.conf'),`listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${root}'\nssl=on\nssl_cert_file='${root}/server.pem'\nssl_key_file='${root}/server-key.pem'\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_error_statement='panic'\n`,{mode:0o600});
  // Start can fail after spawning PostgreSQL. Retain the owned directory
  // unless an actual stop succeeds, even when readiness was never reported.
  started=true;await privateRun(join(bindir,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-w','start']);
  const settings=join(root,'private-settings.json');await writeFile(settings,JSON.stringify({host:'127.0.0.1',port,database:'postgres',user:'clank_contract',password,tls:{ca:await readFile(join(root,'ca.pem'),'utf8')},changePollIntervalMs:0}),{mode:0o600});
  console.log('Owned native PostgreSQL cluster ready: SCRAM, verified TLS, isolated application namespaces.');
  const full=process.argv.includes('--full'),args=full?['--disable-warning=ExperimentalWarning','scripts/check.mjs']:['--disable-warning=ExperimentalWarning','--test','tests/postgres.test.mjs'];
  if(!full)await privateRun(process.execPath,['scripts/build.mjs']);
  const child=spawn(process.execPath,args,{cwd:repository,env:{...process.env,CLANK_POSTGRES_TEST_SETTINGS:settings},stdio:'inherit'});
  const forward=signal=>{child.kill(signal);};const interrupted=()=>forward('SIGINT'),terminated=()=>forward('SIGTERM');
  process.once('SIGINT',interrupted);process.once('SIGTERM',terminated);
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code??1));});
  process.off('SIGINT',interrupted);process.off('SIGTERM',terminated);process.exitCode=Number(status);
} finally {
  if(started){await privateRun(join(bindir,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);stopped=true;}
  if(!started||stopped){await rm(root,{recursive:true,force:true});console.log('Owned PostgreSQL cluster stopped and its private files removed.');}
}
