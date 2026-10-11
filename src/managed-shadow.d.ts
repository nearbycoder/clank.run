import type { SQLiteInternal } from "./sqlite-internal.js";
/** @internal Schema identity is separate from per-session policy and enablement. */
export declare const shadowSchemaIdentity = "clank-platform-shadow/1";
/** @internal Read only: protocol-three startup must never reconstruct missing state. */
export declare function assertProviderShadowSchema(connection: Pick<SQLiteInternal, "prepare">): string;
