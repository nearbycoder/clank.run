export interface CompatibilityFinding { readonly action: string; readonly path: string; readonly severity: "breaking" | "review" | "info"; readonly message: string; }
export interface CompatibilityReport { readonly protocol: "clank-contract-compatibility/1"; readonly ok: boolean; readonly findings: readonly CompatibilityFinding[]; }
type Shape = Record<string, any>;
interface ContractAction { name: string; kind?: string; access?: string; agent?: boolean; input: Shape; output: Shape; scope?: string; actionPath?: string; }

/** Conservative compatibility check for backend manifests or complete MCP manifests/tool catalogs. */
export function compareContracts(baseline: unknown, candidate: unknown): CompatibilityReport {
  const before = actions(baseline);
  const after = actions(candidate);
  if (before.kind !== after.kind) throw new TypeError("Compare manifests of the same kind.");
  const findings: CompatibilityFinding[] = [];
  const add = (action: string, path: string, severity: CompatibilityFinding["severity"], message: string) => {
    if (findings.length >= 5000) throw new TypeError("Contract comparison exceeds 5000 findings.");
    findings.push(Object.freeze({ action, path, severity, message }));
  };
  for (const [name, old] of before.actions) {
    const next = after.actions.get(name);
    if (!next) { add(name, "action", "breaking", "Action was removed or renamed."); continue; }
    if (old.kind !== next.kind) add(name,"kind","breaking","Action kind changed.");
    if (old.access !== "required" && next.access === "required") add(name,"access","breaking","Authentication is now required.");
    if (old.agent && !next.agent) add(name,"agent","breaking","Action is no longer exposed to agents.");
    if (before.kind === "mcp" && (!old.scope || !next.scope)) add(name,"scope","review","Scope metadata is absent; use complete Clank MCP manifests to verify grant compatibility.");
    if (old.actionPath !== next.actionPath) add(name,"actionPath","breaking","The action behind this tool name changed.");
    if (old.scope !== next.scope) add(name,"scope","breaking","Required scope changed; existing grants may no longer work.");
    subset(old.input, next.input, "input", (path, severity, message) => add(name,path,severity,message));
    subset(next.output, old.output, "output", (path, severity, message) => add(name,path,severity,message));
  }
  for (const name of after.actions.keys()) if (!before.actions.has(name)) add(name,"action","info","Action was added.");
  return Object.freeze({ protocol: "clank-contract-compatibility/1", ok: findings.every(item=>item.severity === "info"), findings: Object.freeze(findings) });
}

function actions(input: unknown): { kind: string; actions: Map<string, ContractAction> } {
  const encoded = JSON.stringify(input);
  if (!encoded || encoded.length > 2_000_000) throw new TypeError("Contract must be bounded JSON.");
  const source = JSON.parse(encoded);
  const kind = source?.protocol === "clank-live/1" ? "backend" : "mcp";
  if (source?.nextCursor) throw new TypeError("Combine all MCP catalog pages before comparison.");
  const list = kind === "backend" ? source.functions : source?.tools;
  if (!Array.isArray(list) || list.length > 1000) throw new TypeError("Expected a backend manifest or complete MCP tools catalog.");
  const result = new Map<string, ContractAction>();
  for (const item of list) {
    if (!item || typeof item.name !== "string" || !/^[A-Za-z0-9_.-]{1,256}$/.test(item.name) || result.has(item.name)) throw new TypeError("Action names must be unique bounded identifiers.");
    if (kind === "backend" && (!["query","mutation"].includes(item.kind) || !["public","required"].includes(item.access))) throw new TypeError("Backend action kind/access is invalid.");
    if (item.requiredScope !== undefined && (typeof item.requiredScope !== "string" || item.requiredScope.length > 256)) throw new TypeError("Invalid required scope.");
    const inputSchema = kind === "backend" ? item.args : item.inputSchema;
    const outputSchema = kind === "backend" ? item.returns : item.outputSchema;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) throw new TypeError("Every action needs an input schema.");
    if (outputSchema !== undefined && (!outputSchema || typeof outputSchema !== "object" || Array.isArray(outputSchema))) throw new TypeError("Output schema must be an object.");
    result.set(item.name,{name:item.name,kind:kind === "backend" ? item.kind : item.annotations?.readOnlyHint === true ? "query" : "mutation",access:item.access,agent:item.agent === true,input:inputSchema,output:outputSchema ?? {},scope:kind === "mcp" ? item.requiredScope : undefined,actionPath:item.actionPath});
  }
  return { kind, actions: result };
}

const annotations = new Set(["title","description","examples","$comment","deprecated","readOnly","writeOnly"]);
const supported = new Set(["type","enum","const","properties","required","additionalProperties","items","minimum","maximum","exclusiveMinimum","exclusiveMaximum","minLength","maxLength","minItems","maxItems","uniqueItems"]);
function subset(source: Shape, target: Shape, path: string, add: (path: string,severity:"breaking"|"review",message:string)=>void, depth=0): void {
  if (depth > 32) { add(path,"review","Schema exceeds the comparison depth limit.");return; }
  if (!source || !target || typeof source !== "object" || typeof target !== "object" || Array.isArray(source) || Array.isArray(target)) { add(path,"review","Unsupported schema representation.");return; }
  if (canonical(source) === canonical(target)) return;
  for (const key of new Set([...Object.keys(source),...Object.keys(target)])) if (!supported.has(key) && !annotations.has(key) && canonical(source[key]) !== canonical(target[key])) add(`${path}.${key}`,"review","Changed schema keyword requires manual compatibility review.");
  const types = (value: any): string[] => value === undefined ? ["null","boolean","object","array","number","integer","string"] : Array.isArray(value) ? value : [value];
  const from = types(source.type), to = types(target.type);
  if (from.some(type=>!to.includes(type) && !(type === "integer" && to.includes("number")))) add(`${path}.type`,"breaking","Values previously allowed by the contract may be rejected.");
  const values = (schema: Shape) => "const" in schema ? [schema.const] : schema.enum;
  const oldValues = values(source), newValues = values(target);
  if (newValues !== undefined && (!Array.isArray(newValues) || !Array.isArray(oldValues) || oldValues.some(value=>!newValues.some((candidate:any)=>canonical(value)===canonical(candidate))))) add(`${path}.enum`,"breaking","The allowed value set no longer contains all required values.");
  for (const key of ["minimum","exclusiveMinimum","minLength","minItems"]) if (target[key] !== undefined && (source[key] === undefined || target[key] > source[key])) add(`${path}.${key}`,"breaking","The lower bound became stricter.");
  for (const key of ["maximum","exclusiveMaximum","maxLength","maxItems"]) if (target[key] !== undefined && (source[key] === undefined || target[key] < source[key])) add(`${path}.${key}`,"breaking","The upper bound became stricter.");
  if (target.uniqueItems === true && source.uniqueItems !== true) add(`${path}.uniqueItems`,"breaking","Array uniqueness is newly required.");
  if (from.includes("object") && to.includes("object")) {
    const left = source.properties ?? {}, right = target.properties ?? {};
    const requiredFrom = source.required ?? [], requiredTo = target.required ?? [];
    if (!Array.isArray(requiredFrom) || !Array.isArray(requiredTo) || !left || !right || typeof left !== "object" || typeof right !== "object") { add(path,"review","Object schema requires manual review.");return; }
    for (const name of requiredTo) if (!requiredFrom.includes(name)) add(`${path}.${name}`,"breaking","A field is required that was not guaranteed before.");
    if (target.additionalProperties === false && source.additionalProperties !== false) add(`${path}.additionalProperties`,"breaking","Additional fields are no longer accepted.");
    for (const name of new Set([...Object.keys(left),...Object.keys(right)])) {
      const a = Object.hasOwn(left,name) ? left[name] : source.additionalProperties === false ? false : source.additionalProperties ?? {};
      const b = Object.hasOwn(right,name) ? right[name] : target.additionalProperties === false ? false : target.additionalProperties ?? {};
      if (a === false) continue;
      if (b === false) add(`${path}.${name}`,"breaking","A previously permitted field is no longer accepted.");
      else subset(a === true ? {} : a,b === true ? {} : b,`${path}.${name}`,add,depth+1);
    }
    if (target.additionalProperties && typeof target.additionalProperties === "object") subset(source.additionalProperties && typeof source.additionalProperties === "object" ? source.additionalProperties : {}, target.additionalProperties,`${path}.*`,add,depth+1);
  }
  if (from.includes("array") && to.includes("array")) subset(source.items ?? {},target.items ?? {},`${path}[]`,add,depth+1);
}
function canonical(value: any): string { return JSON.stringify(value, (_key,item)=>item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item); }
