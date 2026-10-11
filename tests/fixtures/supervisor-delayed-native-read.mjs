// An owned scheduler fault: delay before the guardian's first snapshot read
// while its coordinator renews. No SQL rows or clock values are replaced.
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {writeFileSync,renameSync} from 'node:fs';
if(process.env.CLANK_SUPERVISOR_GUARDIAN){
  const sqlite=createRequire(import.meta.url)('node:sqlite'),Native=sqlite.DatabaseSync;
  const save=evidence=>{
    const path=process.env.CLANK_SUPERVISOR_DELAYED_READ_EVIDENCE;if(!path)return;
    writeFileSync(path+'.tmp',JSON.stringify(evidence),{mode:0o600});renameSync(path+'.tmp',path);
  };
  sqlite.DatabaseSync=class extends Native{
    constructor(path,options){
      super(path,options);
      this.observer=new Native(path,{readOnly:true});this.observer.exec('PRAGMA busy_timeout=250;PRAGMA trusted_schema=OFF;PRAGMA query_only=ON');
      this.renewal=this.observer.prepare('SELECT updated_at FROM clank_platform_supervisor_lease WHERE singleton=1');
      this.stateReads=0;this.evidence=undefined;
    }
    prepare(query){
      const statement=super.prepare(query);
      if(query==='SELECT * FROM clank_platform_supervisor_state WHERE singleton=1'){
        const get=statement.get.bind(statement),gate=new Int32Array(new SharedArrayBuffer(4));
        statement.get=(...parameters)=>{
          // The first read must finish guardian readiness before a deliberately
          // delayed polling read can require a renewal from its coordinator.
          if(++this.stateReads!==2)return get(...parameters);
          const beforeReadAt=Date.now(),deadline=performance.now()+2000;let renewed;
          do{
            renewed=this.renewal.get();if(renewed?.updated_at>beforeReadAt)break;
            if(performance.now()>=deadline){save({beforeReadAt,observedRenewalAt:renewed?.updated_at,timedOut:true});throw new Error('No actual coordinator renewal before the guardian snapshot.');}
            Atomics.wait(gate,0,0,5);
          }while(true);
          const row=get(...parameters);
          this.evidence={beforeReadAt,observedRenewalAt:renewed.updated_at,afterStateReadAt:Date.now(),stateReadNumber:this.stateReads};
          return row;
        };
      }
      if(query==='SELECT * FROM clank_platform_supervisor_lease WHERE singleton=1'){
        const get=statement.get.bind(statement);
        statement.get=(...parameters)=>{
          const row=get(...parameters);
          if(this.evidence){save({...this.evidence,afterReadAt:Date.now(),epoch:row?.epoch,updatedAt:row?.updated_at,expiresAt:row?.expires_at,controllerPid:row?.controller_pid});this.evidence=undefined;}
          return row;
        };
      }
      return statement;
    }
    close(){try{super.close();}finally{this.observer.close();}}
  };
  syncBuiltinESMExports();
}
