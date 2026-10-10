// Actual disposable backend process. Native auth, voting and commit use the same SQLite store.
import {createServer} from 'node:http';
import {defineAuth,defineBackend,defineDatabase,defineTable,openBackend,s} from '../../dist/index.js';
import {defineReviewedAction} from '../../dist/reviewed-actions.js';
const path=process.argv[2];if(!path)throw new Error('Supply the owned native fixture store.');
const schema=defineDatabase({items:defineTable({done:s.boolean()}).owned(),members:defineTable({userId:s.string(),role:s.string(),epoch:s.string()})});
const finish=defineReviewedAction(schema,{revision:'finish_v1',title:'Reviewed finish',args:s.object({id:s.string()}),previewDependencies:'records',
  authorize:({auth})=>Boolean(auth.user),authorizeApproval:({auth})=>Boolean(auth.user),
  preview:({db},{id})=>{const item=db.table('items').get(id);if(!item)throw new Error('Missing item');return {id,before:item.done};},
  approvalQuorum:{revision:'quorum_v1',minimum:2,requiredRoles:['reviewer','operator'],membership:({db,auth})=>{
    const member=db.table('members').query().where('userId',auth.user.id).first();
    return member?{scope:'quorum_company_01',role:member.role,version:member._id+':'+member._version+':'+member.epoch,policyVersion:'policy_v1'}:null;
  }},execute:({db},{id})=>{db.table('items').patch(id,{done:true});return {id};}});
const definition=defineBackend({schema,auth:defineAuth({password:{cost:1024,maxMemory:4*1024*1024},mfa:{send(){}}})}).functions(()=>({}));
const runtime=await openBackend(definition,{path,reviewedActions:{actions:{finish}}});
const held=[];
process.on('message',message=>{if(message?.release)for(const release of held.splice(0))release();if(message?.close)server.close(()=>{runtime.close();process.exit(0);});});
const server=createServer(async(incoming,outgoing)=>{
  try {
    if(incoming.method!=='POST' || incoming.url!=='/commit'){outgoing.writeHead(404).end();return;}
    let text='';for await(const part of incoming){text+=part;if(Buffer.byteLength(text)>4096)throw new Error('Bounded native fixture input exceeded.');}
    const input=JSON.parse(text);if(typeof input.planId!=='string' || input.planId.length>200)throw new Error('Invalid plan.');
    const auth=await runtime.auth.resolve(new Request('http://127.0.0.1:42507/commit',{headers:{cookie:incoming.headers.cookie??''}}));
    const receipt=runtime.reviewedActions.commit(input.planId,auth);
    process.send({committed:receipt.id});
    if(input.hold===true)await new Promise(resolve=>held.push(resolve));
    outgoing.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(receipt));
  }catch(error){outgoing.writeHead(Number.isInteger(error?.status)?error.status:400,{'content-type':'application/json'}).end(JSON.stringify({error:error?.code??'NATIVE_FIXTURE_REJECTED'}));}
});
server.listen(0,'127.0.0.1',()=>process.send({ready:true,url:'http://127.0.0.1:'+server.address().port,pid:process.pid}));
