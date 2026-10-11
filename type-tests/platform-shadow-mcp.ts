import * as framework from "@clank.run/framework";
import type { PlatformShadowList, PlatformShadowResponse } from "../src/platform.ts";
declare const list: PlatformShadowList;
declare const detail: PlatformShadowResponse;
const reports = list.sessions.map(session => session.report);
const cursor: string | null = list.nextBefore;
// @ts-expect-error Raw-target capture is private to the native adapter, never a public grant.
const capture = framework.captureCanonicalRequestTarget;
// @ts-expect-error Native target evidence is not a public authorization or proof API.
const proof = framework.hasCanonicalRequestTarget;
// @ts-expect-error Private security modules are not package exports.
import { hasCanonicalRequestTarget } from "@clank.run/framework/security";
void [reports, cursor, detail, capture, proof, hasCanonicalRequestTarget];
