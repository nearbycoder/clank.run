import {openOrganizationSecurityPolicies, createOrganizationSecurityClient, type OrganizationSecurityRequirements, type OrganizationSecurityPolicyController} from '../src/organization-security-policy.ts';
import {defineDatabase,openSQLite,defineAuth,openAuth,type AuthRequest,type AuthState,type AuthClient} from '../src/index.ts';
import type {ClankPlatformOptions} from '../src/platform.ts';
const database=await openSQLite(defineDatabase({}));
const auth=await openAuth(defineAuth(),database);
const policy:OrganizationSecurityPolicyController=openOrganizationSecurityPolicies(database,auth,{
  membership:()=>null,members:()=>[],exists:()=>true,audit(){},
});
const requirements:OrganizationSecurityRequirements={factor:'passkey',ssoOnly:true,sessionMaxAgeMs:3600000,enrollmentGraceMs:0};
declare const current:AuthRequest;
policy.preview('organization_01',current,requirements);
policy.change('organization_01',current,{requirements,expectedVersion:1,operationId:'policy_operation_01'});
policy.captureDelegation('organization_01','cli_credential_01',current);
policy.authorizeDelegation('organization_01','cli_credential_01',current.requireUser().id);
const platform:ClankPlatformOptions={dataDirectory:'/private/control',publicUrl:'https://platform.example.test',organizationSecurity:{operatorRecovery:true}};
void platform;
// @ts-expect-error Unsupported assurance cannot silently disable policy.
const unsupported:OrganizationSecurityRequirements={...requirements,factor:'provider-claims'};
// @ts-expect-error Every policy write needs an expected version.
policy.change('organization_01',current,{requirements,operationId:'missing_version_01'});
declare const display:AuthState;
// @ts-expect-error Display metadata is not a server authentication capability.
policy.authorizeAuth('organization_01',display);
// @ts-expect-error Membership projection must be synchronous.
openOrganizationSecurityPolicies(database,auth,{membership:async()=>null,members:()=>[],exists:()=>true,audit(){}});
void unsupported;

declare const browser:AuthClient;
const client=createOrganizationSecurityClient({auth:browser,prefix:'/__clank/organizations',timeoutMs:15000});
await client.preview('organization_01',requirements);
await client.change('organization_01',{requirements,expectedVersion:1,operationId:'policy_client_operation_01'});
await client.recover('organization_01',{ownerId:current.requireUser().id,confirmation:'organization_01',reason:'Known enrolled owner restored',expectedVersion:2,operationId:'policy_recovery_operation_02'});
// @ts-expect-error JSON display state lacks session signals and CSRF authority.
createOrganizationSecurityClient({auth:display});
// @ts-expect-error Client writes also need an expected version.
await client.change('organization_01',{requirements,operationId:'missing_client_version_01'});
