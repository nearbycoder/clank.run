import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('workbench CLI reads optional performance policies and exits nonzero for violations',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'clank-performance-policy-'));
 try{
  const capture=join(directory,'page.har'),budget=join(directory,'budgets.json'),baseline=join(directory,'before.har');
  const har={log:{pages:[{id:'page',startedDateTime:'2026-10-17T00:00:00Z',pageTimings:{onLoad:100}}],entries:[{pageref:'page',startedDateTime:'2026-10-17T00:00:00Z',request:{url:'https://app.example.invalid/'},response:{status:200,bodySize:100,content:{mimeType:'text/html'}}}]}};
  await writeFile(capture,JSON.stringify(har));await writeFile(baseline,JSON.stringify(har));
  const run=()=>spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','scripts/clank.mjs','workbench','performance',capture,budget,`--baseline=${baseline}`,'--json'],{encoding:'utf8',timeout:30000});
  const policies={requests:10,bodyBytes:1000,javascriptBytes:1000,cssBytes:1000,maxLoadTimeMs:99,resourceBudgets:[{resource:'https://app.example.invalid/',maxBytes:99,maxRequests:0}],regressionBudgets:{bodyBytes:{absolute:0,percent:0}}};
  await writeFile(budget,JSON.stringify(policies));let child=run();assert.equal(child.status,1,child.stderr);
  let report=JSON.parse(child.stdout);assert.equal(report.ok,false);assert.equal(report.policyChecks.length,5);assert.equal(report.policyChecks.filter(x=>!x.passed).length,3);
  policies.maxLoadTimeMs=100;policies.resourceBudgets[0].maxBytes=100;policies.resourceBudgets[0].maxRequests=1;
  await writeFile(budget,JSON.stringify(policies));child=run();assert.equal(child.status,0,child.stderr);report=JSON.parse(child.stdout);assert.equal(report.ok,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
