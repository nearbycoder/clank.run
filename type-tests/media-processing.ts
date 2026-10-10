import {openMediaProcessing,type OpenMediaProcessingOptions,type MediaProcessingInput} from '../src/media-processing.ts';
import {openMediaProcessing as root} from '@clank.run/framework';
import type {AuthRequest,AuthState} from '../src/auth.ts';
declare const options:OpenMediaProcessingOptions;
declare const caller:AuthRequest;
declare const displayed:AuthState;
const input:MediaProcessingInput={operationId:'thumbnail-exact-01',transform:'thumbnail',sourceKey:'original.png',destinationKey:'thumb.png'};
openMediaProcessing(options).then(processing=>{
  const receipt=processing.enqueue(caller,input),attempt:number=receipt.attempt,current:boolean=receipt.outputCurrent;
  processing.get(caller,receipt.id);processing.cancel(caller,receipt.id);processing.workOnce({workerId:'media-worker',leaseMs:1000});
  // @ts-expect-error Display state is not authenticated server request authority.
  processing.enqueue(displayed,input);
  // @ts-expect-error Media workers cannot be redirected to unrelated job queues.
  processing.startWorker({queues:['other-jobs']});
  void [attempt,current];
});
root(options);
// @ts-expect-error Exact retry identity is mandatory.
const missing:MediaProcessingInput={transform:'thumbnail',sourceKey:'original.png',destinationKey:'thumb.png'};
// @ts-expect-error Authorization must be synchronous and return undefined.
openMediaProcessing({...options,authorize:async()=>undefined});
// @ts-expect-error A transform declares its finite output byte budget.
const unbounded:OpenMediaProcessingOptions={...options,transforms:[{name:'copy',revision:'1',sourceBucket:'images',destinationBucket:'images',maxInputBytes:1024,handler:()=>({bytes:new Uint8Array(0),contentType:'image/png'})}]};
void [missing,unbounded];
