import {writeSync} from 'node:fs';
import {openPlatform} from '../../dist/platform.js';
const options=JSON.parse(process.env.CLANK_STAGE_REOPEN_OPTIONS);
try{
  const platform=await openPlatform({...options,onError:error=>writeSync(2,String(error.stack??error)+'\n')});
  writeSync(1,'UNEXPECTED_READY\n');await platform.close();process.exitCode=2;
}catch(error){writeSync(2,String(error.stack??error)+'\n');process.exitCode=1}
