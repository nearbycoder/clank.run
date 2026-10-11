import type { PlatformStagedReleaseResponse, PlatformStagedRelease } from '../src/platform.ts';
const release: PlatformStagedRelease = {id:'release_id',projectId:'project_id',purpose:'shadow-upload',status:'staged',digest:'a'.repeat(64),artifactBytes:42,storageBytes:42,artifactAvailable:true,
  runnerArtifact:{bytes:42,storage:'local'},previousReleaseId:null,frameworkVersion:'0.24.0',nodeVersion:'v26.10.0',createdAt:100,activatedAt:null,failure:null,providerGeneration:null,migrations:'migrations'};
const response: PlatformStagedReleaseResponse = {ok:true,release};
// @ts-expect-error Upload-only receipts never authorize activation.
const active: PlatformStagedRelease = {...release,status:'active'};
// @ts-expect-error The original upload must be durably available in a successful receipt.
const unavailable: PlatformStagedRelease = {...release,artifactAvailable:false};
// @ts-expect-error A stage receipt cannot claim a provider writer generation.
const writer: PlatformStagedRelease = {...release,providerGeneration:1};
// @ts-expect-error The private idempotency key is not part of the response contract.
response.release.idempotencyKey;
void [response,active,unavailable,writer];
