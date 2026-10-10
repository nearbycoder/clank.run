// Owned, actual TCP fault proxy. It forwards SCRAM and native SQL unchanged,
// then drops the acknowledgement of one real PostgreSQL COMMIT.
import {createServer,connect} from 'node:net';
const upstream=Number(process.env.CLANK_POSTGRES_PROXY_PORT);
if(!process.send||!Number.isInteger(upstream)||upstream<1||upstream>65535)throw new Error('Owned PostgreSQL fault proxy configuration is required.');
const sockets=new Set();let armed=false;
const server=createServer(client=>{
  const native=connect({host:'127.0.0.1',port:upstream});sockets.add(client);sockets.add(native);
  let input=Buffer.alloc(0),output=Buffer.alloc(0),startup=true,commit=false,documentInsert=false,nativeWrite=false;
  const close=()=>{client.destroy();native.destroy();sockets.delete(client);sockets.delete(native);};
  for(const socket of [client,native]){socket.on('error',close);socket.on('close',close);}
  client.on('data',chunk=>{
    input=Buffer.concat([input,chunk]);if(input.length>1024*1024)return close();
    while(input.length>=(startup?4:5)){
      const size=startup?input.readInt32BE(0):input.readInt32BE(1)+1;
      if(size<5||size>1024*1024)return close();if(input.length<size)return;
      const message=input.subarray(0,size);input=input.subarray(size);
      if(!startup&&message[0]===80){const zero=message.indexOf(0,5),end=message.indexOf(0,zero+1);if(zero===5&&end>zero){const sql=message.subarray(zero+1,end).toString();documentInsert=sql.startsWith('INSERT INTO public.clank_pg_documents');if(sql==='COMMIT'&&armed&&nativeWrite)commit=true;}}
      startup=false;native.write(message);
    }
  });
  native.on('data',chunk=>{
    output=Buffer.concat([output,chunk]);if(output.length>1024*1024)return close();
    while(output.length>=5){
      const size=output.readInt32BE(1)+1;if(size<5||size>1024*1024)return close();if(output.length<size)return;
      const message=output.subarray(0,size);output=output.subarray(size);
      if(documentInsert&&message[0]===67&&message.subarray(5).toString()==='INSERT 0 1\0'){nativeWrite=true;documentInsert=false;}
      if(commit&&message[0]===67&&message.subarray(5).toString()==='COMMIT\0'){
        armed=false;process.send({kind:'native-commit-acknowledgement-dropped'});return close();
      }
      client.write(message);
    }
  });
});
process.on('message',message=>{if(message.kind==='arm'){armed=true;process.send({kind:'armed'});}if(message.kind==='stop'){for(const socket of sockets)socket.destroy();server.close(()=>process.disconnect());}});
server.listen(0,'127.0.0.1',()=>process.send({kind:'ready',port:server.address().port}));
