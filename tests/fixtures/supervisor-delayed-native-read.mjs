// An owned scheduler fault: delay the guardian's actual native lease read while
// its coordinator continues renewing. No SQL rows or clock values are replaced.
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
if(process.env.CLANK_SUPERVISOR_GUARDIAN){
  const sqlite=createRequire(import.meta.url)('node:sqlite'),Native=sqlite.DatabaseSync;
  sqlite.DatabaseSync=class extends Native{
    prepare(query){
      const statement=super.prepare(query);
      if(query==='SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1'){
        const get=statement.get.bind(statement),gate=new Int32Array(new SharedArrayBuffer(4));
        statement.get=(...parameters)=>{
          const beforeReadAt=Date.now();Atomics.wait(gate,0,0,150);const row=get(...parameters),afterReadAt=Date.now();
          if(process.env.CLANK_SUPERVISOR_DELAYED_READ_EVIDENCE)writeFileSync(process.env.CLANK_SUPERVISOR_DELAYED_READ_EVIDENCE,JSON.stringify({beforeReadAt,afterReadAt,epoch:row?.epoch,updatedAt:row?.updated_at,expiresAt:row?.expires_at,controllerPid:row?.controller_pid}),{mode:0o600});
          return row;
        };
      }
      return statement;
    }
  };
  syncBuiltinESMExports();
}
