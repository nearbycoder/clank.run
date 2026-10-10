import {createOrganizationServiceAccountClient, type ServiceAccountIdentity, type ServiceAccountPermission} from '@clank.run/framework/service-accounts';
import {createOrganizationServiceAccountClient as fromRoot, type AuthRequest} from '@clank.run/framework';
import type {PlatformRuntime} from '@clank.run/framework/platform';
declare const platform:PlatformRuntime;
const authenticated=platform.authenticateServiceAccount(new Request('https://platform.test/api/service-account'));
authenticated.assertCurrent();
const principalId:string=authenticated.identity.id;
// @ts-expect-error A JSON identity lacks the server current-authentication guard.
const trusted:typeof authenticated=authenticated.identity;
// @ts-expect-error An authenticated machine is never a human AuthRequest.
const humanCaller:AuthRequest=authenticated;
void [principalId,trusted,humanCaller];
const client=createOrganizationServiceAccountClient({timeoutMs:500,headers:()=>({'x-clank-csrf':'fresh'})});
fromRoot().list('organization_01');
const permissions:readonly ServiceAccountPermission[]=['read','secrets'];
client.create('organization_01',{name:'Release robot',ownerId:'human_owner_01',operationId:'create_exact_01'});
client.change('organization_01','machine_account_01',{name:'Release robot',ownerId:'human_owner_01',enabled:false,expectedVersion:2,operationId:'disable_exact_01'});
client.issue('organization_01','machine_account_01',{projectId:'project_exact_01',permissions,expiresAt:Date.now()+3600000,expectedVersion:1,operationId:'credential_exact_01'}).then(result=>{
  const secret:string=result.accessToken;
  const count:number=result.credential.authenticatedRequests;
  // @ts-expect-error Displayed metadata does not authenticate a human session.
  const human:AuthRequest=result.account;
  void [secret,count,human];
});
// @ts-expect-error Machines cannot administer or mint other credentials.
const privileged:ServiceAccountPermission='tokens';
// @ts-expect-error Explicit version fences are mandatory.
client.issue('organization_01','machine_account_01',{projectId:'project_exact_01',permissions,expiresAt:Date.now()+3600000,operationId:'missing_version_01'});
// @ts-expect-error A machine display identity has no browser session.
const session:ServiceAccountIdentity={kind:'service-account',id:'machine_account_01',organizationId:'organization_01',ownerId:'human_owner_01',credentialId:'credential_exact_01',projectId:'project_exact_01',permissions,expiresAt:123,session:{id:'session_exact_01'}};
void [privileged,session];
