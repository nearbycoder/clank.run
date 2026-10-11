import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';

const [pidFile]=process.argv.slice(2);
if(typeof pidFile!=='string')throw new Error('Owned PID file is required.');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
const stat=readFileSync('/proc/'+child.pid+'/stat','utf8');
writeFileSync(pidFile,JSON.stringify({pid:child.pid,birth:stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19]}));
child.unref();
process.exit(0);
