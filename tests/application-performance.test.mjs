import assert from 'node:assert/strict';
import test from 'node:test';
import { assessApplicationPerformance } from '../dist/application-performance.js';
const budgets = { requests: 10, bodyBytes: 1000, javascriptBytes: 400, cssBytes: 100 };
const start = '2026-09-06T12:00:00.000Z';
function entry(path, mime, bytes, extra = {}) { return { pageref: 'page', startedDateTime: start, request: { url: `https://example.invalid${path}` }, response: { status: 200, bodySize: bytes, content: { mimeType: mime } }, ...extra }; }
function har(entries) { return { log: { pages: [{ id: 'page', startedDateTime: start, pageTimings: { onLoad: 1000 } }], entries } }; }
const html = entry('/', 'text/html', 100);
test('page budgets include transitive scripts, styles, assets and repeated requests with resource deltas', () => {
  const old = har([html, entry('/app.js?token=secret', 'text/javascript', 100), entry('/removed.png', 'image/png', 20)]);
  const report = assessApplicationPerformance(har([html, entry('/app.js?token=secret', 'text/javascript', 200), entry('/dependency.js','application/javascript', 150), entry('/app.css', 'text/css', 50), entry('/image.png','image/png', 100), entry('/image.png','image/png', 100)]), budgets, { baseline: old });
  assert.equal(report.ok, true);
  assert.deepEqual(report.measurements, { requests: 6, bodyBytes: 700, javascriptBytes: 350, cssBytes: 50 });
  assert.equal(report.changes.find(x => x.resource.endsWith('/app.js')).deltaBytes,100);
  assert.equal(report.changes.find(x => x.resource.endsWith('/removed.png')).deltaBytes,-20);
  assert.equal(JSON.stringify(report).includes('secret'),false);
  assert.equal(assessApplicationPerformance(har([html, entry('/large.js','text/javascript',401)]), budgets).ok,false);
});
test('unknown sizes, missing documents, cache hits, invalid status and ambiguous pages cannot pass', () => {
  for (const entries of [[], [entry('/bad.js','text/javascript',-1)], [html, {...entry('/x','text/css',1), response:{status:304,bodySize:0,content:{mimeType:'text/css'}}}], [html, entry('/x','text/css',1,{_fromCache:true})], [html, entry('/x','text/css',1,{pageref:undefined})], [html, {...entry('/x','text/css',1), response:{status:500,bodySize:1,content:{mimeType:'text/css'}}}]]) assert.equal(assessApplicationPerformance(har(entries),budgets).ok,false);
  assert.throws(() => assessApplicationPerformance({log:{pages:[],entries:[]}},budgets));
  assert.throws(() => assessApplicationPerformance(har([html]),{...budgets,requests:NaN}));
  assert.equal(assessApplicationPerformance(har([html]),budgets,{baseline:har([])}).ok,false);
});
test('page selection includes requests begun before load completion and excludes later interaction', () => {
  const input=har([html,entry('/late.js','text/javascript',2000,{startedDateTime:'2026-09-06T12:00:02.000Z'}),entry('/other.js','text/javascript',2000,{pageref:'other'})]);
  input.log.pages.push({...input.log.pages[0],id:'other'});
  assert.throws(()=>assessApplicationPerformance(input,budgets));
  assert.equal(assessApplicationPerformance(input,budgets,{pageId:'page'}).measurements.requests,1);
});

test('load time and exact per-resource request/byte limits contribute to overall status',()=>{
 const input=har([html,entry('/app.js?secret=x','text/javascript',100),entry('/app.js?secret=y','text/javascript',100)]);
 const report=assessApplicationPerformance(input,budgets,{maxLoadTimeMs:999,resourceBudgets:[{resource:'https://example.invalid/app.js',maxBytes:199,maxRequests:1}]});
 assert.equal(report.ok,false);assert.equal(report.loadTimeMs,1000);assert.equal(report.policyChecks.length,3);assert.ok(report.policyChecks.every(x=>!x.passed));
 assert.equal(assessApplicationPerformance(input,budgets,{maxLoadTimeMs:1000,resourceBudgets:[{resource:'https://example.invalid/app.js',maxBytes:200,maxRequests:2},{resource:'https://example.invalid/absent',maxBytes:0}]}).ok,true);
});
test('baseline regression policies support absolute and relative growth without hiding absolute failures',()=>{
 const baseline=har([html,entry('/app.js','text/javascript',100)]),current=har([html,entry('/app.js','text/javascript',150)]);
 let report=assessApplicationPerformance(current,budgets,{baseline,regressionBudgets:{javascriptBytes:{absolute:50,percent:50},requests:{absolute:0}}});
 assert.equal(report.ok,true);assert.equal(report.policyChecks.length,3);
 report=assessApplicationPerformance(current,budgets,{baseline,regressionBudgets:{javascriptBytes:{absolute:49,percent:49}}});assert.equal(report.ok,false);assert.ok(report.policyChecks.every(x=>!x.passed));
 assert.equal(assessApplicationPerformance(baseline,budgets,{baseline:current,regressionBudgets:{bodyBytes:{absolute:0,percent:0}}}).ok,true);
 assert.equal(assessApplicationPerformance(current,budgets,{baseline:har([html]),regressionBudgets:{javascriptBytes:{percent:100}}}).ok,false,'zero baseline permits no percentage growth');
});
test('duplicate, origin and resource-type summaries retain only sanitized aggregate data',()=>{
 const external=entry('/font.woff2?token=SECRET','font/woff2',30);external.request.url='https://user:password@cdn.example.invalid/font.woff2?token=SECRET#private';
 const report=assessApplicationPerformance(har([html,entry('/a.js?token=SECRET','text/javascript',10),entry('/a.js?token=OTHER','text/javascript',10),entry('/a.css','text/css',5),entry('/x.png','image/png',5),external,entry('/clip','video/mp4',5),entry('/json','application/json',5)]),budgets);
 assert.equal(report.ok,true);assert.equal(report.duplicateResources.length,1);assert.equal(report.duplicateResources[0].requests,2);
 assert.equal(report.origins.length,2);assert.equal(report.origins.find(x=>x.group==='https://cdn.example.invalid').bodyBytes,30);
 assert.deepEqual(report.resourceTypes.map(x=>x.group).sort(),['css','font','html','image','javascript','media','other']);
 assert.equal(report.resourceTypes.reduce((n,x)=>n+x.requests,0),report.measurements.requests);
 assert.ok(!/SECRET|OTHER|password|private/.test(JSON.stringify(report)));assert.ok(Object.isFrozen(report.origins[0]));
});
test('performance policy options reject invalid, ambiguous and unbounded rules',()=>{
 for(const options of [{maxLoadTimeMs:NaN},{maxLoadTimeMs:-1},{resourceBudgets:[{resource:'https://example.invalid/'}]},{resourceBudgets:[{resource:'https://example.invalid/?token=secret',maxBytes:10}]},{resourceBudgets:[{resource:'https://example.invalid/',maxRequests:-1}]},{resourceBudgets:Array(101).fill({resource:'https://example.invalid/',maxBytes:10})},{resourceBudgets:[{resource:'https://example.invalid/',maxBytes:1},{resource:'https://example.invalid/',maxBytes:2}]},{regressionBudgets:{requests:{absolute:0}}},{baseline:har([html]),regressionBudgets:{bodyBytes:{percent:Infinity}}},{baseline:har([html]),regressionBudgets:{unknown:{absolute:0}}}]) assert.throws(()=>assessApplicationPerformance(har([html]),budgets,options));
});
test('untrusted captures bound issue output, URL size and MIME metadata and reject pre-navigation entries',()=>{
 const old=entry('/old.js','text/javascript',1,{startedDateTime:'2026-09-06T11:59:59.000Z'});
 assert.equal(assessApplicationPerformance(har([html,old]),budgets).ok,false);
 const input=har([html,...Array.from({length:150},(_,i)=>entry(`/bad${i}`,'text/javascript',-1))]);
 assert.equal(assessApplicationPerformance(input,budgets).issues.length,101);
 const huge=entry('/'+'x'.repeat(4100),'text/javascript',1);assert.equal(assessApplicationPerformance(har([html,huge]),budgets).ok,false);
 assert.equal(assessApplicationPerformance(har([html,entry('/bad','x'.repeat(257),1)]),budgets).ok,false);
 const large=har(Array.from({length:2200},(_,i)=>entry('/'+String(i)+'x'.repeat(4000),'text/html',0)));assert.throws(()=>assessApplicationPerformance(large,budgets),/URLs exceed/);
});
