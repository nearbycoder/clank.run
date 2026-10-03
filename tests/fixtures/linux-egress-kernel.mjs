// Executed only after unshare --user --map-root-user --net. All links, routes,
// firewall rules, and sysctls belong to that disposable namespace.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLinuxDockerNetworkPlan, applyLinuxDockerNetworkPolicy, removeLinuxDockerNetworkPolicy } from '../../dist/linux-project-isolation.js';
const executable = (name) => existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : `/usr/sbin/${name}`;
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ip = (...args) => command(executable('ip'), args);
const children = [];
async function namespace(server) {
  const source = server
    ? "require('node:http').createServer((q,s)=>s.end('endpoint')).listen(40219,'0.0.0.0',()=>console.log('ready'));"
    : "console.log('ready');setInterval(()=>{},10000)";
  const child = spawn('/usr/bin/unshare', ['--net', process.execPath, '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (code) => { if (code !== null) reject(new Error(`namespace process exited ${code}`)); }); });
  return child.pid;
}
const inside = (pid, ...args) => command('/usr/bin/nsenter', ['--target', String(pid), '--net', ...args]);
async function request(pid, address) {
  const source = `fetch('http://${address}:40219',{signal:AbortSignal.timeout(500)}).then(r=>r.text()).then(v=>process.stdout.write(v+'\\n',()=>process.exit(0))).catch(()=>process.stdout.write('blocked\\n',()=>process.exit(0)))`;
  return inside(pid, process.execPath, '--eval', source).trim();
}
try {
  const tenant = await namespace(false), endpoint = await namespace(true);
  const plan = await createLinuxDockerNetworkPlan('kernel-test', 'project', { allowCidrs: ['1.1.1.1/32', '10.99.0.0/24'] });
  ip('link', 'set', 'lo', 'up');
  ip('link', 'add', plan.bridge, 'type', 'bridge');
  ip('addr', 'add', '10.200.0.1/24', 'dev', plan.bridge); ip('link', 'set', plan.bridge, 'up');
  ip('link', 'add', 'tenant-host', 'type', 'veth', 'peer', 'name', 'tenant-peer');
  ip('link', 'set', 'tenant-host', 'master', plan.bridge); ip('link', 'set', 'tenant-host', 'up');
  ip('link', 'set', 'tenant-peer', 'netns', String(tenant));
  inside(tenant, executable('ip'), 'addr', 'add', '10.200.0.2/24', 'dev', 'tenant-peer');
  inside(tenant, executable('ip'), 'link', 'set', 'tenant-peer', 'up');
  inside(tenant, executable('ip'), 'link', 'set', 'lo', 'up');
  inside(tenant, executable('ip'), 'route', 'add', 'default', 'via', '10.200.0.1');
  ip('link', 'add', 'remote-host', 'type', 'veth', 'peer', 'name', 'remote-peer');
  ip('addr', 'add', '10.201.0.1/24', 'dev', 'remote-host'); ip('link', 'set', 'remote-host', 'up');
  ip('link', 'set', 'remote-peer', 'netns', String(endpoint));
  inside(endpoint, executable('ip'), 'addr', 'add', '10.201.0.2/24', 'dev', 'remote-peer');
  inside(endpoint, executable('ip'), 'link', 'set', 'remote-peer', 'up');
  inside(endpoint, executable('ip'), 'link', 'set', 'lo', 'up');
  inside(endpoint, executable('ip'), 'route', 'add', 'default', 'via', '10.201.0.1');
  for (const address of ['1.1.1.1', '9.9.9.9', '10.99.0.3']) {
    inside(endpoint, executable('ip'), 'addr', 'add', `${address}/32`, 'dev', 'lo');
    ip('route', 'add', `${address}/32`, 'via', '10.201.0.2');
  }
  command(executable('sysctl'), ['-w', 'net.ipv4.ip_forward=1']);
  const host = spawn(process.execPath, ['--eval', "require('node:http').createServer((q,s)=>s.end('host')).listen(40219,'10.200.0.1',()=>console.log('ready'));"], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(host);
  await new Promise((resolve, reject) => { host.stdout.once('data', resolve); host.once('error', reject); });
  if (await request(tenant, '10.200.0.1') !== 'host') throw new Error('host service fixture is not reachable');
  // Establish real reachability before installing rules, so a broken route cannot pass denial checks.
  if (await request(tenant, '1.1.1.1') !== 'endpoint' || await request(tenant, '9.9.9.9') !== 'endpoint'
    || await request(tenant, '10.99.0.3') !== 'endpoint') throw new Error('namespace routing fixture is not reachable');
  await applyLinuxDockerNetworkPolicy(plan, executable('nft'));
  await applyLinuxDockerNetworkPolicy(plan, executable('nft')); // Atomic idempotent replacement.
  const results = {};
  for (const address of ['1.1.1.1', '9.9.9.9', '10.99.0.3', '10.200.0.1']) results[address] = await request(tenant, address);
  if (results['1.1.1.1'] !== 'endpoint' || results['9.9.9.9'] !== 'blocked'
    || results['10.99.0.3'] !== 'blocked' || results['10.200.0.1'] !== 'blocked') throw new Error(`unexpected packet results: ${JSON.stringify(results)}`);
  await removeLinuxDockerNetworkPolicy(plan, executable('nft'));
  if (await request(tenant, '9.9.9.9') !== 'endpoint') throw new Error('cleanup did not restore disposable namespace routing');
  console.log(JSON.stringify({ realKernel: true, results }));
} finally { for (const child of children) child.kill('SIGKILL'); }
