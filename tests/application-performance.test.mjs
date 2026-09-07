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
