import { createDevtools, exportHydrationSnapshot, observeHydration, withHydrationSource, h, hydrate, type HydrationDiagnostic } from '../src/index.ts';
const inspector = createDevtools({ hydration: true, maxEvents: 20 });
const exported: string = exportHydrationSnapshot(inspector.snapshot());
void exported;
const stop = observeHydration((event: HydrationDiagnostic) => {
  const outcome: 'patch' | 'remount' = event.outcome; void outcome;
  // @ts-expect-error Diagnostics exclude SSR text.
  event.actual.text;
  // @ts-expect-error Snapshots are immutable.
  event.path.push(0);
});
hydrate(document.body, withHydrationSource(h('button'), { file: 'Button.tsx', line: 2, column: 4 }));
// @ts-expect-error Locations are numeric source coordinates.
withHydrationSource(h('button'), { file: 'Button.tsx', line: '2', column: 4 });
// @ts-expect-error Capture is explicitly opt-in.
createDevtools({ hydration: 'enabled' });
stop(); inspector.dispose();
import { compile, transformTSX } from '@clank.run/framework/compiler';
compile('export const view = <p />', { filename: 'View.tsx', hydrationDiagnostics: true });
transformTSX('const view = <p />', { filename: 'View.tsx', hydrationDiagnostics: true });
// @ts-expect-error Compiler instrumentation is a boolean option.
compile('export const view = <p />', { hydrationDiagnostics: 'yes' });

import { observeHydration as subpathObserver } from '../src/hydration-inspection.ts';
void subpathObserver;
