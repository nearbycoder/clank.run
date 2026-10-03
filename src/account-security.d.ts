import type { Renderable } from "./dom.js";
import type { AuthClient } from "./auth.js";
export declare function AccountSecurity(props: { auth: AuthClient<any> }): Renderable;
export declare function PasswordRecoveryForm(props: { auth: AuthClient<any>; resetToken?: string }): Renderable;
export declare function EmailVerificationForm(props: { auth: AuthClient<any>; token: string }): Renderable;
