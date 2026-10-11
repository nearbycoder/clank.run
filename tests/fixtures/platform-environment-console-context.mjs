import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

// Older focused console tests extract individual functions into their own VM.
// Install the actual shared environment helpers and their state dependencies;
// these tests still exercise their original log/activity/runtime assertions.
export function installEnvironmentConsoleContext(context, html) {
  context.initial ??= { authenticated: false, email: null, impersonation: null };
  context.organizationSecurityView ??= {scope:null,generation:0,latest:null,draft:null,review:null,busy:false,challenge:null,drafts:new Map(),owner:null};
  context.q('#organization-security-dialog').close ??= () => {};
  const resetSecurity=html.match(/^function resetOrganizationSecurity\([^\n]+/m)?.[0];
  assert.ok(resetSecurity,'Shared organization security reset must be present.');
  runInNewContext(resetSecurity,context);
  context.state.environmentDrafts ??= new Map();
  context.state.environmentHistoryGeneration ??= 0;
  context.state.environmentProject ??= null;
  context.state.channelDrafts ??= new Map();
  context.state.channelProject ??= null;
  context.state.channelGeneration ??= 0;
  context.state.channelListGeneration ??= 0;
  context.state.channelHistoryGeneration ??= 0;
  context.state.windowGeneration ??= 0;
  context.state.windowMutationBusy ??= false;
  context.state.dependencyProject ??= null;
  context.state.dependencyGeneration ??= 0;
  context.state.dependencyBusy ??= false;
  context.state.dependencyCanConfigure ??= false;
  for (const id of ['#dependency-form', '#dependency-recovery-form']) context.q(id).reset ??= () => {};
  const channels = ['resetChannelReview', 'updateChannelFields', 'saveChannelDraft', 'resetReleaseWindowView', 'resetDependencyState', 'syncDependencyControls', 'updateDependencyOverrideFields'].map(name => {
    const source = html.match(new RegExp('^function ' + name + '\\([^\\n]+', 'm'))?.[0];
    assert.ok(source, 'Shared channel helper must be present: ' + name);
    return source;
  }).join('\n');
  runInNewContext(channels, context);
  const reset=html.match(/^function resetEnvironmentReview\(\)[^\n]+/m)?.[0];
  const save=html.match(/^function saveEnvironmentDraft\(\)\{[\s\S]*?^\}/m)?.[0];
  assert.ok(reset&&save,'Console environment helpers must be present.');
  runInNewContext(reset+'\n'+save,context);
}
