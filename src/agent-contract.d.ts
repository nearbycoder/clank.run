import type { FunctionReference } from "./backend.js";
export type AgentActionTarget = string | FunctionReference<"query" | "mutation", any, any>;
export interface AgentActionControl {
    path: string;
    id?: string;
    label?: string;
    tag: string;
}
export interface AgentBackendFunctionManifest {
    name: string;
    kind: "query" | "mutation";
    agent: boolean;
    description?: string;
}
export interface AgentBackendManifest {
    protocol: "clank-live/1";
    contractRevision: string | null;
    functions: readonly AgentBackendFunctionManifest[];
}
export type AgentActionParityIssueCode = "REVISION_MISMATCH" | "MCP_DISABLED" | "MISSING_CONTROL_ID" | "DUPLICATE_CONTROL_ID" | "UNKNOWN_ACTION" | "INTERNAL_ACTION" | "MISSING_DESCRIPTION" | "MISSING_UI_ACTION";
export interface AgentActionParityIssue {
    code: AgentActionParityIssueCode;
    message: string;
    action?: string;
    controlId?: string;
}
export interface AgentActionParityOptions {
    /** Actions that must be represented by at least one rendered control. */
    requiredActions?: readonly AgentActionTarget[];
    /** Expected deployment-sensitive backend/MCP contract revision. */
    expectedRevision?: string | null;
    /** Require precise descriptions for UI-addressable actions. Defaults to true. */
    requireDescriptions?: boolean;
}
export interface AgentActionParityReport {
    protocol: "clank-agent-action-parity/1";
    ok: boolean;
    contractRevision: string | null;
    controls: readonly AgentActionControl[];
    uiActions: readonly string[];
    agentActions: readonly string[];
    requiredActions: readonly string[];
    issues: readonly AgentActionParityIssue[];
}
export interface VerifyAgentActionParityOptions extends AgentActionParityOptions {
    manifestUrl?: string;
    fetch?: typeof fetch;
    maxManifestBytes?: number;
}
export declare class AgentActionParityError extends Error {
    readonly report: AgentActionParityReport;
    readonly name = "AgentActionParityError";
    constructor(report: AgentActionParityReport);
}
/** Resolves a literal or typed backend reference into its MCP/browser action path. */
export declare function agentActionPath(target: AgentActionTarget): string;
/** Extracts stable server-action controls from SSR HTML or a rendered DOM root. */
export declare function inspectAgentActions(surface: string | ParentNode): readonly AgentActionControl[];
/** Compares rendered UI actions with the backend manifest used to derive MCP tools. */
export declare function checkAgentActionParity(surface: string | ParentNode | readonly AgentActionControl[], manifestInput: AgentBackendManifest | unknown, options?: AgentActionParityOptions): AgentActionParityReport;
export declare function assertAgentActionParity(surface: string | ParentNode | readonly AgentActionControl[], manifest: AgentBackendManifest | unknown, options?: AgentActionParityOptions): AgentActionParityReport;
/**
 * Fetches the no-store backend manifest and verifies the currently rendered UI.
 * It throws AgentActionParityError for a semantic mismatch.
 */
export declare function verifyAgentActionParity(surface: string | ParentNode, options?: VerifyAgentActionParityOptions): Promise<AgentActionParityReport>;
