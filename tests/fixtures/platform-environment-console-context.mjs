import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

// Older focused console tests extract individual functions into their own VM.
// Install the actual shared environment helpers and their state dependencies;
// these tests still exercise their original log/activity/runtime assertions.
export function installEnvironmentConsoleContext(context, html) {
  context.state.environmentDrafts ??= new Map();
  context.state.environmentHistoryGeneration ??= 0;
  context.state.environmentProject ??= null;
  context.state.channelDrafts ??= new Map();
  context.state.channelProject ??= null;
  context.state.channelGeneration ??= 0;
  context.state.channelListGeneration ??= 0;
  context.state.channelHistoryGeneration ??= 0;
  const channels = ['resetChannelReview', 'updateChannelFields', 'saveChannelDraft'].map(name => {
    const source = html.match(new RegExp('^function ' + name + '\\(\\)[^\\n]+', 'm'))?.[0];
    assert.ok(source, 'Shared channel helper must be present: ' + name);
    return source;
  }).join('\n');
  runInNewContext(channels, context);
  const reset=html.match(/^function resetEnvironmentReview\(\)[^\n]+/m)?.[0];
  const save=html.match(/^function saveEnvironmentDraft\(\)\{[\s\S]*?^\}/m)?.[0];
  assert.ok(reset&&save,'Console environment helpers must be present.');
  runInNewContext(reset+'\n'+save,context);
}
