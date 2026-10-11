import {openPointInTimeTransferSource,inspectPointInTimeTransferSourceSeal,exportSealedPointInTimeTransfer,type PointInTimeRecovery,type PointInTimeTransferSourceOptions,type PointInTimeTransferSourceInspectionOptions} from '@clank.run/framework/point-in-time';
declare const recovery:PointInTimeRecovery;
declare const options:PointInTimeTransferSourceOptions;
declare const inspection:PointInTimeTransferSourceInspectionOptions;
const source=openPointInTimeTransferSource(recovery,options);
source.export({after:options.initialCursor,throughSequence:1});
source.seal(options.initialCursor);
inspectPointInTimeTransferSourceSeal(inspection);
exportSealedPointInTimeTransfer({...inspection,expectedCursor:inspection.after,throughSequence:1});
// @ts-expect-error Async callbacks cannot supply synchronous native ownership.
openPointInTimeTransferSource(recovery,{...options,assertSourceCurrent:async()=>{}});
// @ts-expect-error Boolean claims are not native ownership assertions.
openPointInTimeTransferSource(recovery,{...options,assertSourceCurrent:()=>true});
// @ts-expect-error Read-only restart must also assert synchronously.
inspectPointInTimeTransferSourceSeal({...inspection,assertCurrent:async()=>{}});
// @ts-expect-error Nonundefined synchronous values are refused too.
inspectPointInTimeTransferSourceSeal({...inspection,assertCurrent:()=>1});
// @ts-expect-error Existing source identity cannot be rebound per export.
source.export({identity:options.identity,after:options.initialCursor,throughSequence:1});
// @ts-expect-error Terminal tail export requires an independently retained target cursor.
exportSealedPointInTimeTransfer({...inspection,throughSequence:1});
