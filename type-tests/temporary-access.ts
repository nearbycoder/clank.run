import {createTemporaryAccessClient,createTemporaryAccessView,TemporaryAccessError,type TemporaryAccessAction,type TemporaryAccessCreate,type TemporaryAccessRevoke,type TemporaryAccessGrant} from '../src/temporary-access.ts';
import type {AuthClient,AuthState,ClankPlatformOptions} from '../src/index.ts';
declare const auth:AuthClient;
const client=createTemporaryAccessClient({auth,timeoutMs:15000});
const create:TemporaryAccessCreate={recipientId:'current_member_01',action:'preview.create',durationMs:900000,reason:'Create an isolated review preview.',expectedVersion:0,operationId:'reviewed_operation_01'};
const accepted=await client.create('current_project_01',create);
const grant:TemporaryAccessGrant=accepted.grant;
const revoke:TemporaryAccessRevoke={grantId:grant.id,reason:'Review window closed.',expectedVersion:accepted.acceptedVersion,operationId:'revoke_operation_02'};
await client.revoke('current_project_01',revoke);
const view=createTemporaryAccessView(document.createElement('div'),{projectId:'current_project_01',client,account:()=>({userId:'current_owner_01',sessionId:'current_session_01'}),canManage:()=>true,members:[]});
view.hasPendingChanges();await view.refresh();view.dispose();void view.disposed;
const options:ClankPlatformOptions={dataDirectory:'/private/platform',publicUrl:'https://platform.example.test',organizationSecurity:{},temporaryAccess:{maxGrants:1000,maxReceipts:10000}};void options;
const failure:TemporaryAccessError=new TemporaryAccessError('EXAMPLE','Reviewed failure.',409);void failure.status;
// @ts-expect-error The first privilege cannot widen to secret reads or generic administration.
const unsupported:TemporaryAccessAction='secrets.read';
// @ts-expect-error New grants require explicit compare-and-swap authority.
client.create('current_project_01',{recipientId:'current_member_01',action:'preview.create',durationMs:900000,reason:'Missing version.',operationId:'missing_version_01'});
// @ts-expect-error Every revocation must preserve a separately reviewed exact operation ID.
client.revoke('current_project_01',{grantId:grant.id,reason:'Missing operation.',expectedVersion:1});
// @ts-expect-error Display-only authority does not become writable browser grant state.
grant.active=true;
declare const display:AuthState;
// @ts-expect-error Browser display state cannot provide a current client session/CSRF source.
createTemporaryAccessClient({auth:display});
// @ts-expect-error A token string cannot substitute for current native auth signals.
createTemporaryAccessClient({auth:{user:'token',session:'token',csrfHeader:'token'}});
