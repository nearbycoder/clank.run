// Private container entry, not an authority or readiness producer. The original
// backend constructor authenticates and owns the bootstrap after app import.
const MAX_ENVIRONMENT_BYTES=3*1024*1024,MAX_BOOTSTRAP_BYTES=16384;
const MAX_FRAME_BYTES=MAX_ENVIRONMENT_BYTES+MAX_BOOTSTRAP_BYTES+128;
const STARTUP=Symbol.for("clank.provider.source.startup.v1");
const LEGACY=Symbol.for("clank.provider.source.bootstrap.v1");
const FAILURE="Clank source entry startup refused.";
function refuse():never{throw new Error(FAILURE);}
function boundedStructure(bytes:Uint8Array):void{
  let string=false,escape=false,depth=0,tokens=0;
  for(const byte of bytes){
    if(string){if(escape)escape=false;else if(byte===92)escape=true;else if(byte===34)string=false;continue;}
    if(byte===34){string=true;continue;}
    if(byte===123||byte===91){if(++depth>8)refuse();tokens++;}
    else if(byte===125||byte===93){if(--depth<0)refuse();tokens++;}
    else if(byte===58||byte===44)tokens++;
    if(tokens>4096)refuse();
  }
  if(string||depth!==0)refuse();
}
// Private transport parser. It grants no constructor, readiness or write authority.
export async function readSourceStartupFrame(input:any):Promise<string>{
  const Buffer=(globalThis as any).Buffer;
  const bytes=Buffer.alloc(MAX_FRAME_BYTES+1);let length=0;
  const timer=setTimeout(()=>input.destroy(new Error(FAILURE)),30000);
  try{
    let ended=false;
    for await(const chunk of input){
      if(ended)refuse();
      if(!Buffer.isBuffer(chunk)||length+chunk.length>MAX_FRAME_BYTES+1)refuse();
      const end=chunk.indexOf(10);
      if(end!==-1&&end!==chunk.length-1)refuse();
      chunk.copy(bytes,length);length+=chunk.length;
      ended=end!==-1;
    }
    if(!ended||length===1||length-1>MAX_FRAME_BYTES||bytes[length-2]===13)refuse();
    const body=bytes.subarray(0,length-1);boundedStructure(body);
    return new TextDecoder("utf-8",{fatal:true}).decode(body);
  }finally{clearTimeout(timer);bytes.fill(0);input.destroy();}
}
async function main():Promise<void>{
  const process=(globalThis as any).process,Buffer=(globalThis as any).Buffer;
  if(process.platform!=="linux"||!process.getuid?.()||!process.getgid?.()||process.cwd()!=="/app"||process.argv.length!==3)refuse();
  const entry=process.argv[2];
  if(typeof entry!=="string"||entry.length===0||entry.length>4096||entry.startsWith("/")||/[\\\0\r\n]/u.test(entry)||entry.split("/").some((part:string)=>!part||part==="."||part===".."))refuse();
  if(Object.hasOwn(globalThis,STARTUP)||Object.hasOwn(globalThis,LEGACY))refuse();
  const pathName="node:path",urlName="node:url",fsName="node:fs/promises";
  const [path,url,fs]=await Promise.all([import(pathName),import(urlName),import(fsName)]);
  const target=path.resolve("/app",entry);
  if(!target.startsWith("/app/")||await fs.realpath(target)!==target||!(await fs.stat(target)).isFile()||target===url.fileURLToPath(import.meta.url))refuse();
  const {environment,source}=decodeSourceStartupEnvelope(await readSourceStartupFrame(process.stdin));
  for(const [name,value]of Object.entries(environment))process.env[name]=value;
  process.umask(0o077);
  Object.defineProperty(globalThis,STARTUP,{value:source,writable:false,enumerable:false,configurable:true});
  // This import conveys no readiness/write authority. A later producer must
  // prove original constructor/native completion, not slot removal or app logs.
  await import(url.pathToFileURL(target).href);
}
export function decodeSourceStartupEnvelope(encoded:string):{environment:Record<string,string>;source:string}{
  const Buffer=(globalThis as any).Buffer;
  if(typeof encoded!=="string"||encoded.length>MAX_FRAME_BYTES||Buffer.byteLength(encoded)>MAX_FRAME_BYTES)refuse();
  boundedStructure(Buffer.from(encoded));
  const envelope=JSON.parse(encoded);
  if(!envelope||typeof envelope!=="object"||Array.isArray(envelope)||Object.keys(envelope).length!==2||!Object.hasOwn(envelope,"environment")||!Object.hasOwn(envelope,"bootstrap")||JSON.stringify(envelope)!==encoded)refuse();encoded="";
  const environment=envelope.environment,bootstrap=envelope.bootstrap;
  if(!environment||typeof environment!=="object"||Array.isArray(environment)||Object.keys(environment).length>512||Buffer.byteLength(JSON.stringify(environment))>MAX_ENVIRONMENT_BYTES)refuse();
  for(const [name,value]of Object.entries(environment))if(!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name)||typeof value!=="string"||value.includes("\0"))refuse();
  const fields=["protocol","binding","bindingSha256","containerId","catalogPath","grantSecret","controlSecret","recoveryKey","workerChannel"];
  if(!bootstrap||typeof bootstrap!=="object"||Array.isArray(bootstrap)||Object.keys(bootstrap).length!==fields.length||fields.some(name=>!Object.hasOwn(bootstrap,name))||bootstrap.protocol!=="clank-provider-source-bootstrap/2"||bootstrap.catalogPath!=="/run/clank-source/catalog.sqlite")refuse();
  const source=JSON.stringify(bootstrap);if(Buffer.byteLength(source)>MAX_BOOTSTRAP_BYTES)refuse();
  delete envelope.environment;delete envelope.bootstrap;
  return {environment,source};
}
const process=(globalThis as any).process;
if(process?.argv?.[1]){
  const name="node:url",{pathToFileURL}=await import(name);
  if(import.meta.url===pathToFileURL(process.argv[1]).href)try{await main();}catch{process.stderr.write(FAILURE+"\n");process.exit(1);}
}
