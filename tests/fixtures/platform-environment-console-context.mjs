import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

// Older focused console tests extract individual functions into their own VM.
// Install the actual shared environment helpers and their state dependencies;
// these tests still exercise their original log/activity/runtime assertions.
export function installEnvironmentConsoleContext(context, html) {
  context.state.environmentDrafts ??= new Map();
  context.state.environmentHistoryGeneration ??= 0;
  context.state.environmentProject ??= null;
  const reset=html.match(/^function resetEnvironmentReview\(\)[^\n]+/m)?.[0];
  const save=html.match(/^function saveEnvironmentDraft\(\)\{[\s\S]*?^\}/m)?.[0];
  assert.ok(reset&&save,'Console environment helpers must be present.');
  runInNewContext(reset+'\n'+save,context);
}
