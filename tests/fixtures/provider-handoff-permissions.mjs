import {DatabaseSync} from 'node:sqlite';
const [filename,mode,markerJSON]=process.argv.slice(2),database=new DatabaseSync(filename);
database.exec('PRAGMA journal_mode=WAL');
if(markerJSON){const marker=JSON.parse(markerJSON);database.exec(marker.sql);database.prepare('INSERT INTO clank_provider_handoff_owner VALUES(?,?,?,?,?)').run(...marker.values);}
else database.exec('UPDATE clank_provider_service_owner SET protocol=1');
if(mode==='active')database.exec('BEGIN IMMEDIATE');
process.send({ready:true,marker:!!markerJSON});
setInterval(()=>{},1000);
