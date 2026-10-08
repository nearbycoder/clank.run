import { signal } from "./core.ts";
import { h, type Renderable } from "./dom.ts";
import type { AuthClient, AuthSessionRecord, AuthPasskeyRecord } from "./auth.ts";

/** Reusable password recovery, reset, email verification, passkey and session controls. */
export function AccountSecurity(props: { auth: AuthClient<any> }): Renderable {
  const sessions = signal<readonly AuthSessionRecord[]>([]), passkeys = signal<readonly AuthPasskeyRecord[]>([]);
  const status = signal(""), password = signal(""), nextPassword = signal(""), name = signal(""), code = signal(""), challenge = signal("");
  const busy = signal(false);
  let userId = props.auth.user.peek()?.id, sessionId = props.auth.session.peek()?.id, generation = 0, disposed = false;
  const accountGeneration = () => {
    const nextUser = props.auth.user.value?.id, nextSession = props.auth.session.value?.id;
    if (nextUser !== userId || nextSession !== sessionId) {
      userId = nextUser; sessionId = nextSession; generation++;
      sessions.value = []; passkeys.value = []; status.value = ""; busy.value = false;
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
    sessions.value = nextSessions; passkeys.value = nextPasskeys;
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
