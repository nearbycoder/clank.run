// Forward actual native messages. After PostgreSQL returns the retained oldest
// revision, prune it through a second real session before delivering its ACK.
import {createServer,connect} from 'node:net';
import {readFile} from 'node:fs/promises';
import {openPostgres,defineDatabase,defineTable,s} from '../../dist/index.js';
const options=JSON.parse(await readFile(process.env.CLANK_POSTGRES_TEST_SETTINGS,'utf8'));
const namespace=process.env.CLANK_POSTGRES_PROCESS_NAMESPACE;
if(!process.send||!namespace)throw new Error('Owned retention race configuration is required.');
const writer=await openPostgres(defineDatabase({records:defineTable({title:s.string()})}),{...options,namespace,changeRetentionRevisions:1});
const sockets=new Set();let armed=false;
const server=createServer(client=>{
  const native=connect({host:'127.0.0.1',port:options.port});sockets.add(client);sockets.add(native);
  let input=Buffer.alloc(0),output=Buffer.alloc(0),startup=true,retained=false;
  const close=()=>{client.destroy();native.destroy();sockets.delete(client);sockets.delete(native);};
  for(const socket of [client,native]){socket.on('error',close);socket.on('close',close);}
  client.on('data',chunk=>{
    input=Buffer.concat([input,chunk]);if(input.length>1024*1024)return close();
    while(input.length>=(startup?4:5)){
      const size=startup?input.readInt32BE(0):input.readInt32BE(1)+1;
      if(size<5||size>1024*1024)return close();if(input.length<size)return;
      const message=input.subarray(0,size);input=input.subarray(size);
      if(!startup&&message[0]===80){const zero=message.indexOf(0,5),end=message.indexOf(0,zero+1);if(zero===5&&end>zero&&message.subarray(zero+1,end).toString().startsWith('SELECT min(revision)')&&armed)retained=true;}
      startup=false;native.write(message);
    }
  });
  native.on('data',chunk=>{
    output=Buffer.concat([output,chunk]);if(output.length>1024*1024)return close();
    while(output.length>=5){
      const size=output.readInt32BE(1)+1;if(size<5||size>1024*1024)return close();if(output.length<size)return;
      const message=output.subarray(0,size);output=output.subarray(size);
      if(retained&&message[0]===67){
        retained=false;armed=false;const before=writer.version;
        for(const title of ['pruned second','pruned third'])writer.transaction(tx=>tx.table('records').insert({title}));
        process.send({kind:'native-retention-pruned',before,after:writer.version});
      }
      client.write(message);
    }
  });
});
process.on('message',message=>{if(message.kind==='arm'){armed=true;process.send({kind:'armed'});}if(message.kind==='stop'){writer.close();for(const socket of sockets)socket.destroy();server.close(()=>process.disconnect());}});
server.listen(0,'127.0.0.1',()=>process.send({kind:'ready',port:server.address().port}));
