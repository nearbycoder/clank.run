import type { DeploymentProviderCanaryController, DeploymentProviderCanaryState, DeploymentProviderShadowState } from '@clank.run/framework/provider-service';
import type { DeploymentRuntimeCapsule } from '@clank.run/framework/runtime-placement';
declare const controller: DeploymentProviderCanaryController;
declare const runtime: DeploymentRuntimeCapsule;
const input={primary:{projectId:'project_shadow',releaseId:'release_primary',generation:1,fence:1,incarnation:'00000000-0000-4000-8000-000000000000'},controllerEpoch:1,operationId:'shadow_operation',runtime,signal:new AbortController().signal};
const canary:Promise<DeploymentProviderCanaryState>=controller.prepare(input);
const shadow:Promise<DeploymentProviderShadowState>=controller.prepare({...input,purpose:'shadow',stateProtocol:'clank-provider-canary/2'});
// @ts-expect-error Shadow purpose requires the explicit state version.
void controller.prepare({...input,purpose:'shadow'});
// @ts-expect-error A shadow must not downgrade to the legacy state.
void controller.prepare({...input,purpose:'shadow',stateProtocol:'clank-provider-canary/1'});
// @ts-expect-error The state version cannot silently select shadow behavior.
void controller.prepare({...input,stateProtocol:'clank-provider-canary/2'});
// @ts-expect-error Explicit shadow return is not an ordinary v1 canary.
const wrong:Promise<DeploymentProviderCanaryState>=shadow;
void shadow.then(value=>{if(value.snapshot){const digest:string=value.snapshot.sha256;void digest;
  // @ts-expect-error Checkpoint identity cannot be mutated by a caller.
  value.snapshot.bytes=1;
}});
void controller.inspect('project_shadow').then(value=>{if(value?.protocol==='clank-provider-canary/2'){const purpose:'shadow'=value.purpose;void purpose;}else if(value){const protocol:'clank-provider-canary/1'=value.protocol;void protocol;}});
void canary;void wrong;
