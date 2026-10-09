import { openOrganizationSso, createOrganizationIdentityClient, AccountSecurity, createAuthClient, type OrganizationSsoOptions, type AuthRuntime, type SQLiteDatabase, type OrganizationIdentityUnlink } from "../dist/index.js";
const options: OrganizationSsoOptions = { applicationOrigin: "https://app.test", providers: [{organizationId:"company",issuer:"https://issuer.test",clientId:"clank",offboardingToken:"12345678901234567890123456789012"}], identityLinking:{policyRevision:1,maxActiveIdentities:5,maxRetainedIdentities:20},onOffboard(user,organization,context){const id:string=user;const org:string=organization;const reason:"offboard"|"unlink"|undefined=context?.reason;void [id,org,reason];} };
declare const database: SQLiteDatabase<any>,auth: AuthRuntime<any>;
const sso=openOrganizationSso(database,auth,options);const handled:boolean=sso.handles(new Request("https://app.test"));void handled;
const browser=createAuthClient(),identities=createOrganizationIdentityClient({auth:browser});AccountSecurity({auth:browser,identities,onIdentityRedirect(url){const redirect:string=url;void redirect;}});
const request:OrganizationIdentityUnlink={identityId:"sso_identity",expectedVersion:1,idempotencyKey:"retained_retry_key"};
identities.list().then(inventory=>{const version:number| null=inventory.policyRevision;const active:boolean|undefined=inventory.identities[0]?.active;void [version,active];});identities.start("company").then(result=>{const expiry:number=result.expiresAt;void expiry;});identities.unlink(request).then(result=>{const signedOut:true=result.signedOut;const version:number=result.identity.version;void [signedOut,version];});
// @ts-expect-error Linking requires an explicit numeric policy revision.
const missingRevision:OrganizationSsoOptions={...options,identityLinking:{maxActiveIdentities:2}};
// @ts-expect-error CAS versions are numbers, not string identifiers.
identities.unlink({identityId:"identity",expectedVersion:"1",idempotencyKey:"key"});
// @ts-expect-error Cross-account target selection is not exposed.
identities.start({userId:"another-account",organizationId:"company"});
// @ts-expect-error Account security requires a real identity client contract.
AccountSecurity({auth:browser,identities:{list:async()=>({})}});
void missingRevision;
