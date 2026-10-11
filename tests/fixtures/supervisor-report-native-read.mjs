import {createRequire,syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
if(process.env.CLANK_SUPERVISOR_GUARDIAN && process.env.CLANK_REPORT_GUARDIAN_READ){
  const sqlite=createRequire(import.meta.url)('node:sqlite'),Native=sqlite.DatabaseSync;
  sqlite.DatabaseSync=class extends Native{
    observed=null;
    prepare(sql){const statement=super.prepare(sql);if(sql==='SELECT * FROM clank_platform_shadow_state LIMIT 2'){const all=statement.all.bind(statement);statement.all=(...args)=>{const rows=all(...args);this.observed=rows.length===1?rows[0].schema_id:null;return rows}}return statement;}
    exec(sql){const result=super.exec(sql);if(sql==='ROLLBACK' && this.observed){writeFileSync(process.env.CLANK_REPORT_GUARDIAN_READ,JSON.stringify({pid:process.pid,schemaId:this.observed}));this.observed=null;}return result;}
  };syncBuiltinESMExports();
}
