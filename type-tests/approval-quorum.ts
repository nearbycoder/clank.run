import {defineReviewedAction, type ReviewedApprovalProgress, type ReviewedApprovalQuorum} from '../src/reviewed-actions.ts';
import {defineAuth,defineBackend,defineDatabase,defineTable,openBackend,s} from '../src/index.ts';
const schema=defineDatabase({tasks:defineTable({done:s.boolean()}).owned(),members:defineTable({userId:s.string(),role:s.string(),epoch:s.string(),scope:s.string(),policyVersion:s.string()})});
const finish=defineReviewedAction(schema,{
  revision:'finish-v2',title:'Finish with two independent roles',args:s.object({id:s.id('tasks')}),previewDependencies:'records',
  authorize:({auth})=>Boolean(auth.user),
  preview:({db},{id})=>{const task=db.table('tasks').get(id);if(!task)throw new Error('Missing task');return {id,before:task.done};},
  authorizeApproval:({auth})=>Boolean(auth.session),
  approvalQuorum:{revision:'review-policy-v1',minimum:2,requiredRoles:['reviewer','operator'],separateRequester:true,voteTtlMs:60000,
    membership:({db,auth},plan)=>{
      const member=db.table('members').query().where('userId',auth.user!.id).first();if(!member)return null;
      const before:boolean=plan.preview.before;
      // @ts-expect-error Preview remains the inferred action preview.
      plan.preview.secret;
      // @ts-expect-error Membership receives a read-only database.
      db.table('members').patch(member._id,{role:'operator'});
      // @ts-expect-error Membership table fields are checked against the action schema.
      member.privatePassword;
      return {scope:member.scope,role:member.role,version:member._id+':'+member._version+':'+member.epoch,policyVersion:member.policyVersion};
    }},
  execute:({db},{id},preview)=>{db.table('tasks').patch(id,{done:true});return {id,before:preview.before};},
});
const backend=await openBackend(defineBackend({schema,auth:defineAuth()}).functions(()=>({})),{reviewedActions:{actions:{finish}}});
const bad:ReviewedApprovalQuorum={revision:'v1',minimum:2,
  // @ts-expect-error Asynchronous membership cannot establish native quorum authority.
  membership:async()=>null};
const incomplete:ReviewedApprovalQuorum={revision:'v1',minimum:2,
  // @ts-expect-error Native policy and membership versions are required.
  membership:()=>({scope:'team',role:'reviewer'})};
declare const progress:ReviewedApprovalProgress;
// @ts-expect-error Public vote progress cannot be mutated.
progress.recordedVotes=99;
// @ts-expect-error Required roles are read-only.
progress.requiredRoles.push('owner');
