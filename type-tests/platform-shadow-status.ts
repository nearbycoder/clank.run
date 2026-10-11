import type { PlatformShadowList, PlatformShadowResponse, PlatformShadowSession } from '../src/platform.ts';
declare const list: PlatformShadowList;
const session: PlatformShadowSession | undefined = list.sessions[0];
const cursor: string | null = list.nextBefore;
const policy = list.policy?.maxSamplePercent;
const sharedFloor: number = list.epoch;
// @ts-expect-error Read-only history never exposes native mutation capabilities.
const mutate = list.retire;
// @ts-expect-error Safe session DTOs never expose the retained principal digest.
const digest = session?.reviewDigest;
// @ts-expect-error Read-only list arrays cannot be edited in place.
list.sessions.push(session!);
// @ts-expect-error A detail response is not a list or cursor envelope.
const wrong: PlatformShadowResponse = list;
void [cursor, policy, sharedFloor, mutate, digest, wrong];
