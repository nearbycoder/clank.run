import { signal } from "./core.ts";
import { h, type Renderable } from "./dom.ts";
import { AuthError } from "./auth.ts";
import type { OrganizationIdentityInventory, OrganizationIdentityUnlink, OrganizationIdentity } from "./organization-sso.ts";
import type { AuthClient, AuthSessionRecord, AuthPasskeyRecord } from "./auth.ts";

export interface OrganizationIdentityClient {
  list(): Promise<OrganizationIdentityInventory>;
  start(organizationId: string): Promise<{ authorizationUrl: string; expiresAt: number }>;
  unlink(input: OrganizationIdentityUnlink): Promise<{ identity: OrganizationIdentity; signedOut: true }>;
}

/** Browser-only identity actions use the existing current auth session and CSRF contract. */
export function createOrganizationIdentityClient(options: { auth: AuthClient<any>; url?: string; prefix?: string; fetch?: typeof fetch }): OrganizationIdentityClient {
  const prefix=options.prefix??"/__clank/sso",transport=options.fetch??fetch;
  if(!/^\/[A-Za-z0-9_/-]+$/u.test(prefix) || prefix.endsWith("/") || prefix.includes("//")) throw new TypeError("Invalid SSO prefix.");
  const request=async(path:string,input?:unknown,verifyCurrent=true) => {
    const userId=options.auth.user.peek()?.id,sessionId=options.auth.session.peek()?.id;
    if(!userId || !sessionId) throw new AuthError("UNAUTHENTICATED","Sign in to manage organization identities.",401);
    const current=()=>options.auth.user.peek()?.id===userId && options.auth.session.peek()?.id===sessionId;
    let response: Response, text="";
    try {
      response=await transport(`${options.url??""}${prefix}/${path}`,{method:input===undefined?"GET":"POST",credentials:"same-origin",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000),headers:input===undefined?{}:{"content-type":"application/json",...options.auth.csrfHeader()},...(input===undefined?{}:{body:JSON.stringify(input)})});
      const reader=response.body?.getReader(),decoder=new TextDecoder();let bytes=0;
      if(reader) {try {for(;;) {const part=await reader.read();if(part.done) break;bytes+=part.value.byteLength;if(bytes>262144) {void reader.cancel().catch(()=>{});throw new AuthError("SSO_RESPONSE","Identity response is too large.",502);}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();} finally {reader.releaseLock();}}
    } catch(error) {
      // Transport/body failures can also hide a committed unlink. Never reload
      // another account on behalf of an obsolete operation.
      if(current()) await options.auth.reload();throw error;
    }
    if(!current()) throw new AuthError("AUTH_FAILED","Account changed before the operation completed.",409);
    let body;
    try {body=JSON.parse(text);} catch {await options.auth.reload();throw new AuthError("SSO_RESPONSE","Invalid identity response.",502);}
    if(!response.ok || body?.ok!==true) {
      // An error may hide an accepted unlink whose response was lost. Reload
      // current authority before leaving any cached identity controls visible.
      await options.auth.reload();
      throw new AuthError(body?.error?.code??"SSO_FAILED",body?.error?.message??"The identity operation failed.",response.status);
    }
    if(verifyCurrent) {await options.auth.reload();if(!current()) throw new AuthError("AUTH_FAILED","Account changed before the operation completed.",409);}
    return body;
  };
  return {
    list:()=>request("identities"),
    async start(organizationId) {
      if(!/^[A-Za-z0-9_-]{1,128}$/u.test(organizationId)) throw new TypeError("Invalid organization ID.");
      const result=await request(`link/${organizationId}`,{}),url=new URL(result.authorizationUrl);
      if(url.protocol!=="https:" && !(url.protocol==="http:" && ["127.0.0.1","[::1]"].includes(url.hostname))) throw new AuthError("SSO_RESPONSE","Invalid provider redirect.",502);
      return {authorizationUrl:url.href,expiresAt:result.expiresAt};
    },
    async unlink(input) {const result=await request("unlink",input,false);await options.auth.reload();return result;},
  };
}

/** Reusable password recovery, reset, email verification, passkey and session controls. */
export function AccountSecurity(props: { auth: AuthClient<any>; identities?: OrganizationIdentityClient; onIdentityRedirect?: (authorizationUrl: string) => void }): Renderable {
  const sessions = signal<readonly AuthSessionRecord[]>([]), passkeys = signal<readonly AuthPasskeyRecord[]>([]);
  const status = signal(""), password = signal(""), nextPassword = signal(""), name = signal(""), code = signal(""), challenge = signal("");
  const busy = signal(false), inventory = signal<OrganizationIdentityInventory | null>(null), organization = signal("");
  const unlinkRequests = new Map<string, OrganizationIdentityUnlink>();
  let userId = props.auth.user.peek()?.id, sessionId = props.auth.session.peek()?.id, generation = 0, disposed = false;
  const accountGeneration = () => {
    const nextUser = props.auth.user.value?.id, nextSession = props.auth.session.value?.id;
    if (nextUser !== userId || nextSession !== sessionId) {
      userId = nextUser; sessionId = nextSession; generation++;
      sessions.value = []; passkeys.value = []; inventory.value = null; organization.value = ""; unlinkRequests.clear(); status.value = ""; busy.value = false;
      password.value = ""; nextPassword.value = ""; name.value = ""; code.value = ""; challenge.value = "";
    }
    return generation;
  };
  const current = (expected: number) => !disposed && accountGeneration() === expected;
  const run = async (operation: (expected: number) => Promise<unknown>, success: string) => {
    const expected = accountGeneration();
    if (disposed || busy.value || !userId) return;
    busy.value = true; status.value = "";
    try { await operation(expected); if (current(expected)) status.value = success; }
    catch (error) { if (current(expected)) status.value = error instanceof Error ? error.message : "The account operation failed."; }
    finally { if (current(expected)) { busy.value = false; password.value = ""; nextPassword.value = ""; code.value = ""; } }
  };
  const refresh = async (expected = accountGeneration()) => {
    if (!current(expected)) return;
    const nextSessions = await props.auth.listSessions();
    if (!current(expected)) return;
    const nextPasskeys = await props.auth.listPasskeys();
    if (!current(expected)) return;
    const nextIdentities=props.identities?await props.identities.list():null;
    if(!current(expected)) return;
    sessions.value = nextSessions; passkeys.value = nextPasskeys; inventory.value=nextIdentities;
    const available=nextIdentities?.providers.filter(provider=>!nextIdentities.identities.some(identity=>identity.active && identity.organizationId===provider.organizationId))??[];
    if(!available.some(provider=>provider.organizationId===organization.value)) organization.value=available[0]?.organizationId??"";
  };
  const button = (text: string, operation: (expected: number) => Promise<unknown>, success: string) => h("button", { type: "button", disabled: () => busy.value, onClick: () => run(operation, success) }, text);
  const field = (label: string, value: ReturnType<typeof signal<string>>, type = "text", autocomplete = "off") => h("label", {}, label, h("input", { type, autocomplete, "bind:value": value, required: true }));
  return h("section", { "aria-label": "Account security", use: () => {
    disposed = false; accountGeneration();
    const stopUser = props.auth.user.subscribe(accountGeneration), stopSession = props.auth.session.subscribe(accountGeneration);
    return () => { disposed = true; generation++; stopUser(); stopSession(); };
  } },
    h("h1", {}, "Account security"), h("p", { role: "status", "aria-live": "polite" }, () => status.value),
    () => { accountGeneration(); return !props.auth.user.value ? h("p", {}, "Sign in to manage your account.") : [
      h("h2", {}, "Email verification"), h("p", {}, () => props.auth.user.value?.emailVerified ? "Email verified." : "Email verification required."),
      button("Send verification email", () => props.auth.requestEmailVerification(), "Verification email requested."),
      h("h2", {}, "Verify a sensitive action"),
      button("Verify with a passkey", () => props.auth.reauthenticateWithPasskey(), "Identity verified. You can now retry the sensitive action."),
      h("form", { onSubmit: (event: Event) => { event.preventDefault(); void run(async (expected) => { if (challenge.value) { await props.auth.finishMfaReauthentication(challenge.value, code.value); if (current(expected)) challenge.value = ""; } else { const result = await props.auth.startMfaReauthentication(password.value); if (current(expected)) challenge.value = result.challengeId; } }, challenge.value ? "Identity verified." : "Verification code sent."); } },
        () => challenge.value ? field("Verification code", code, "text", "one-time-code") : field("Current password", password, "password", "current-password"),
        h("button", { type: "submit", disabled: () => busy.value }, () => challenge.value ? "Verify code" : "Send MFA code")),
      h("h2", {}, "Passkeys"), field("Passkey name", name),
      button("Add a passkey", async (expected) => { await props.auth.registerPasskey(name.value || "Passkey"); await refresh(expected); }, "Passkey added."),
      () => h("ul", {}, ...passkeys.value.map(key => h("li", {}, key.name, " ", button("Remove passkey", async (expected) => { await props.auth.deletePasskey(key.id); await refresh(expected); }, "Passkey removed.")))),
      h("h2", {}, "Active sessions"), button("Refresh account security", refresh, "Security information refreshed."),
      () => h("ul", {}, ...sessions.value.map(session => h("li", {}, `${session.current ? "This session" : "Other session"} · last used ${new Date(session.lastSeenAt).toISOString()} · ${session.authenticationMethod ?? "password"}`, " ", button("Revoke session", async (expected) => { await props.auth.revokeSession(session.id); if (props.auth.user.value) await refresh(expected); }, "Session revoked.")))),
      button("Sign out all sessions", () => props.auth.logoutAll(), "All sessions signed out."),
      ...(props.identities ? [h("h2",{},"Organization identities"),
        h("p",{},"Verify locally with a passkey or MFA, then sign in again at your organization provider. Unlinking removes that organization's access and signs out all browser sessions and generic agents. Sign back in with a remaining credential."),
        button("Refresh organization identities",refresh,"Organization identities refreshed."),
        ()=>inventory.value ? h("div",{},
          !inventory.value.enabled?h("p",{},"Identity linking is disabled."):h("div",{},
            h("label",{},"Organization to link",h("select",{"bind:value":organization,style:{maxWidth:"100%"}},
              ...inventory.value.providers.filter(provider=>!inventory.value!.identities.some(identity=>identity.active && identity.organizationId===provider.organizationId)).map(provider=>h("option",{value:provider.organizationId},provider.organizationId)))),
            h("button",{type:"button",disabled:()=>busy.value || !organization.value,onClick:()=>run(async(expected)=>{
              const result=await props.identities!.start(organization.value);if(!current(expected)) return;
              if(props.onIdentityRedirect) props.onIdentityRedirect(result.authorizationUrl);else if(typeof location!=="undefined") location.assign(result.authorizationUrl);
            },"Continue verification at your organization provider.")},"Link organization identity")),
          h("ul",{},...inventory.value.identities.map(identity=>h("li",{style:{overflowWrap:"anywhere"}},
            `${identity.organizationId} · ${identity.issuer} · ${identity.subject} · ${identity.active?"Active":"Inactive"} · version ${identity.version}`," ",
            ...(identity.active && inventory.value!.enabled?[button(`Unlink identity from ${identity.organizationId}`,async()=>{
              const key=`${identity.id}:${identity.version}`;let input=unlinkRequests.get(key);
              if(!input) {input={identityId:identity.id,expectedVersion:identity.version,idempotencyKey:crypto.randomUUID()};unlinkRequests.set(key,input);}
              await props.identities!.unlink(input);
            },"Identity unlinked. Sign in with a remaining credential.")]:[]))))) : h("p",{},"Refresh to inspect your current organization identities."),
      ]:[]),
      h("h2", {}, "Change password"),
      h("form", { onSubmit: (event: Event) => { event.preventDefault(); void run(() => props.auth.changePassword({ currentPassword: password.value, newPassword: nextPassword.value }), "Password changed; other sessions were revoked."); } },
        field("Current password", password, "password", "current-password"), field("New password", nextPassword, "password", "new-password"), h("button", { type: "submit", disabled: () => busy.value }, "Change password")),
    ]; },
  );
}

export function PasswordRecoveryForm(props: { auth: AuthClient<any>; resetToken?: string }): Renderable {
  const email = signal(""), password = signal(""), status = signal(""), busy = signal(false);
  return h("section", { "aria-label": "Account recovery" }, h("h1", {}, props.resetToken ? "Reset password" : "Recover account"),
    h("p", { role: "status" }, () => status.value),
    h("form", { onSubmit: async (event: Event) => {
      event.preventDefault(); if (busy.value) return; busy.value = true;
      try { if (props.resetToken) await props.auth.resetPassword(props.resetToken, password.value); else await props.auth.requestPasswordReset(email.value); status.value = props.resetToken ? "Password reset. You are signed in." : "If the account exists, a recovery email will arrive shortly."; }
      catch (error) { status.value = error instanceof Error ? error.message : "Recovery failed."; }
      finally { busy.value = false; password.value = ""; }
    } }, h("label", {}, props.resetToken ? "New password" : "Email", h("input", { type: props.resetToken ? "password" : "email", autocomplete: props.resetToken ? "new-password" : "email", required: true, "bind:value": props.resetToken ? password : email })),
    h("button", { type: "submit", disabled: () => busy.value }, props.resetToken ? "Reset password" : "Send recovery email")));
}

export function EmailVerificationForm(props: { auth: AuthClient<any>; token: string }): Renderable {
  const status = signal(""), busy = signal(false);
  return h("section", { "aria-label": "Email verification" }, h("h1", {}, "Verify email"), h("p", { role: "status" }, () => status.value),
    h("button", { type: "button", disabled: () => busy.value, onClick: async () => {
      if (busy.value) return; busy.value = true;
      try { await props.auth.verifyEmail(props.token); status.value = "Email verified."; }
      catch (error) { status.value = error instanceof Error ? error.message : "Verification failed."; }
      finally { busy.value = false; }
    } }, "Verify email"));
}
