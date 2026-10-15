import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {nativeFallbackSourceRevocationState} from './fixtures/provider-platform-api-native.mjs';

test('native API helper recognizes only its exact fenced source credential and cancelled operation',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE clank_platform_evacuations(id TEXT,node_id TEXT,requested_by TEXT,created_at INTEGER,state TEXT,phase TEXT,projects TEXT);
   CREATE TABLE clank_deployment_nodes(id TEXT,region TEXT,endpoint TEXT,capacity INTEGER,labels TEXT,token_hash TEXT,status TEXT,expires_at INTEGER);
   CREATE TABLE clank_deployment_operations(id TEXT,node_id TEXT,project_id TEXT,action TEXT,payload TEXT,fence INTEGER,state TEXT,lease_token_hash TEXT,lease_expires_at INTEGER);`);
  const project={projectId:'project',releaseId:'release',generation:1};
  const original={plan:{id:'plan',nodeId:'native_node',requestedBy:'admin',createdAt:10,projects:[project]},node:{id:'native_node',region:'native',endpoint:'http://127.0.0.1:47231',capacity:4,labels:'{}',token_hash:'original-token'},operation:{id:'operation',projectId:'project',action:'reconcile',payload:{generation:1},fence:1}};
  const progress=JSON.stringify([{...project,backupId:'backup',targetNodeId:'native_target',targetGeneration:2,fallbackState:'running'}]);
  db.prepare('INSERT INTO clank_platform_evacuations VALUES(?,?,?,?,?,?,?)').run('plan','native_node','admin',10,'completed','completed',progress);
  db.prepare('INSERT INTO clank_deployment_nodes VALUES(?,?,?,?,?,?,?,?)').run('native_node','native','http://127.0.0.1:47231',4,'{}','revoked-token','offline',0);
  db.prepare('INSERT INTO clank_deployment_operations VALUES(?,?,?,?,?,?,?,?,?)').run('operation','native_node','project','reconcile',JSON.stringify({generation:1}),1,'cancelled',null,null);
  const state=()=>nativeFallbackSourceRevocationState(db,original);
  assert.equal(state(),'completed');
  db.exec("UPDATE clank_platform_evacuations SET state='running',phase='fenced'");assert.equal(state(),'fenced');
  db.exec("UPDATE clank_platform_evacuations SET phase='relocating'");assert.equal(state(),'fenced');
  db.exec("UPDATE clank_platform_evacuations SET state='completed',phase='completed'");
  for(const [sql,restore] of [
   ["UPDATE clank_platform_evacuations SET state='paused'","UPDATE clank_platform_evacuations SET state='completed'"],
   ["UPDATE clank_platform_evacuations SET phase='quiescing'","UPDATE clank_platform_evacuations SET phase='completed'"],
   ["UPDATE clank_platform_evacuations SET requested_by='other-admin'","UPDATE clank_platform_evacuations SET requested_by='admin'"],
   ["UPDATE clank_platform_evacuations SET node_id='native_target'","UPDATE clank_platform_evacuations SET node_id='native_node'"],
   ["UPDATE clank_deployment_nodes SET token_hash='original-token'","UPDATE clank_deployment_nodes SET token_hash='revoked-token'"],
   ["UPDATE clank_deployment_nodes SET status='active'","UPDATE clank_deployment_nodes SET status='offline'"],
   ["UPDATE clank_deployment_nodes SET expires_at=1000","UPDATE clank_deployment_nodes SET expires_at=0"],
   ["UPDATE clank_deployment_nodes SET capacity=8","UPDATE clank_deployment_nodes SET capacity=4"],
   ["UPDATE clank_deployment_operations SET state='succeeded'","UPDATE clank_deployment_operations SET state='cancelled'"],
   ["UPDATE clank_deployment_operations SET node_id='native_target'","UPDATE clank_deployment_operations SET node_id='native_node'"],
   ["UPDATE clank_deployment_operations SET fence=2","UPDATE clank_deployment_operations SET fence=1"],
   ["UPDATE clank_deployment_operations SET lease_token_hash='live'","UPDATE clank_deployment_operations SET lease_token_hash=NULL"],
  ]){db.exec(sql);assert.equal(state(),undefined,sql);db.exec(restore);assert.equal(state(),'completed');}
  db.prepare('UPDATE clank_platform_evacuations SET projects=?').run(JSON.stringify([{...project,backupId:'backup',targetNodeId:'native_target',targetGeneration:2,fallbackState:'stopped'}]));assert.equal(state(),undefined);
  db.prepare('UPDATE clank_platform_evacuations SET projects=?').run(progress);assert.equal(state(),'completed');
  assert.equal(nativeFallbackSourceRevocationState(db,undefined),undefined);
  assert.equal(nativeFallbackSourceRevocationState(db,{...original,plan:{...original.plan,nodeId:'native_target'}}),undefined);
 }finally{db.close();}
});
