export declare const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export declare const GITHUB_ACTIONS_OIDC_JWKS = "https://token.actions.githubusercontent.com/.well-known/jwks";
export interface GithubActionsOidcPolicy {
    audience: string;
    repository: string;
    repositoryId: string;
    workflowPath: string;
    eventName: "pull_request" | "pull_request_target";
    operation: "deploy" | "remove";
    previewName?: string;
    ref?: string;
}
export interface GithubActionsOidcIdentity {
    readonly issuer: typeof GITHUB_ACTIONS_OIDC_ISSUER;
    readonly subject: string;
    readonly jti: string;
    readonly expiresAt: number;
    readonly repository: string;
    readonly repositoryId: string;
    readonly workflowRef: string;
    readonly workflowSha: string;
    readonly eventName: "pull_request" | "pull_request_target";
    readonly ref: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly previewName: string;
}
export interface GithubActionsOidcVerifierOptions {
    fetch?: typeof fetch;
    now?: () => number;
}
export interface GithubActionsOidcVerifier {
    verify(token: string, policy: GithubActionsOidcPolicy): Promise<GithubActionsOidcIdentity>;
}
export declare class GithubActionsOidcError extends Error {
    readonly code = "INVALID_GITHUB_IDENTITY";
    constructor(cause?: unknown);
}
export declare function createGithubActionsOidcVerifier(options?: GithubActionsOidcVerifierOptions): GithubActionsOidcVerifier;
export declare function repositoryName(value: unknown): string;
export declare function workflowPathName(value: unknown): string;
export declare function branchRef(value: unknown): string;
