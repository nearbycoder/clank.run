export interface LiveSplice { readonly start: number; readonly deleteCount: number; readonly insert: string; }
export interface LiveResumeOptions { maxEntries?: number; maxBytes?: number; maxAgeMs?: number; }
export interface LiveReplayStore { encode(scope:string,previousId:string|null,value:unknown,version:number):{id:string;payload:unknown}; clear():void; }

/** Opaque snapshot IDs are scoped to the exact session/query; a miss always yields a full snapshot. */
export function createLiveReplayStore(options:LiveResumeOptions={}):LiveReplayStore{
 const maximum=options.maxEntries??100,limit=options.maxBytes??8*1024*1024,age=options.maxAgeMs??60000;
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>1000||!Number.isSafeInteger(limit)||limit<1024||limit>64*1024*1024||!Number.isSafeInteger(age)||age<1000||age>300000)throw new TypeError("Invalid live resume retention.");
 const entries=new Map<string,{scope:string;text:string;bytes:number;at:number}>();let bytes=0;
 const remove=(id:string)=>{const entry=entries.get(id);if(entry){bytes-=entry.bytes;entries.delete(id);}};
 return{encode(scope,previousId,value,version){
   const now=Date.now();for(const[id,entry]of entries)if(now-entry.at>=age)remove(id);
   const text=JSON.stringify(value),id=crypto.randomUUID(),full={value,version};
   let payload:unknown=full;const prior=previousId?entries.get(previousId):undefined;
   if(text!==undefined&&prior?.scope===scope){
     let start=0;while(start<prior.text.length&&start<text.length&&prior.text[start]===text[start])start++;
     let end=0;while(end<prior.text.length-start&&end<text.length-start&&prior.text[prior.text.length-end-1]===text[text.length-end-1])end++;
     const delta={kind:"splice-v1",baseId:previousId,version,splice:{start,deleteCount:prior.text.length-start-end,insert:text.slice(start,text.length-end)}};
     if(new TextEncoder().encode(JSON.stringify(delta)).length<new TextEncoder().encode(JSON.stringify(full)).length)payload=delta;
   }
   if(text!==undefined){const size=new TextEncoder().encode(text).length+new TextEncoder().encode(scope).length+128;
     if(size<=limit){while(entries.size>=maximum||bytes+size>limit)remove(entries.keys().next().value!);entries.set(id,{scope,text,bytes:size,at:now});bytes+=size;}
   }
   return{id,payload};
 },clear(){entries.clear();bytes=0;}};
}

/** Apply a validated textual JSON splice without property assignment or prototype mutation. */
export function applyLiveSplice(previous:unknown,splice:LiveSplice,maximumBytes=1024*1024):unknown{
 const text=JSON.stringify(previous);
 if(text===undefined||!splice||!Number.isSafeInteger(splice.start)||splice.start<0||splice.start>text.length||!Number.isSafeInteger(splice.deleteCount)||splice.deleteCount<0||splice.deleteCount>text.length-splice.start||typeof splice.insert!=="string"||!Number.isSafeInteger(maximumBytes)||maximumBytes<1)throw new TypeError("Invalid live resume splice.");
 if(text.length-splice.deleteCount+splice.insert.length>maximumBytes)throw new RangeError("Live resume output exceeds its limit.");
 const result=text.slice(0,splice.start)+splice.insert+text.slice(splice.start+splice.deleteCount);
 if(new TextEncoder().encode(result).length>maximumBytes)throw new RangeError("Live resume output exceeds its limit.");return JSON.parse(result);
}
