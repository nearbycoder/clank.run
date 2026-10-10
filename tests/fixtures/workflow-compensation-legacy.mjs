// Shared source text lets the baseline binary and the new binary define the identical old graph.
export function legacyCompensationCompatibility(api) {
  const schema=api.defineDatabase({events:api.defineTable({value:api.s.string()})});
  const jobs=api.defineJobs({schema}).jobs(({job})=>({work:job({args:{value:api.s.string()},returns:api.s.string(),handler:(_context,{value})=>value})}));
  const workflow=api.defineWorkflow({args:{value:api.s.string()},graph:graph=>{
    const first=graph.step(jobs.jobs.work,{args:({input})=>({value:input.value})});
    const second=graph.step(jobs.jobs.work,{needs:[first],args:({result})=>({value:result(first)})});
    return {first,second};
  }});
  return {schema,workflow,definition:api.defineWorkflows(jobs,{legacy:workflow})};
}
