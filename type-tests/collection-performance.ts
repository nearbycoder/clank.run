import {createLocalSearchIndex, type LocalSearchSettings} from '../src/local-search.ts';
import {createVirtualCollection, type VirtualAlignment, type VirtualRange} from '../src/virtual-collections.ts';
import {assessApplicationPerformance, type ApplicationPerformanceOptions} from '../src/application-performance.ts';

const settings: LocalSearchSettings = {mode:'any',field:'title',ids:['one'],exclude:'archived',phrase:true,sort:'title'};
const index=createLocalSearchIndex();
index.search('hello',settings);
const document=index.get('one');
if(document){
 const title:string=document.title;
 // @ts-expect-error Indexed documents are immutable.
 document.title='changed';
}
index.clear();
// @ts-expect-error Unknown fields are not supported.
index.search('hello',{field:'private'});
// @ts-expect-error Scopes contain IDs, not arbitrary predicates.
index.search('hello',{ids:()=>true});
const model=createVirtualCollection({items:[{id:'one'}],key:item=>item.id,rowHeight:40});
const align:VirtualAlignment='center';
model.scrollToIndex(0,align);model.scrollToKey('one','nearest');model.focusKey('one');model.setOverscan(5);
const position:number=model.indexOf('one');
const range:VirtualRange=model.visibleRange();
// @ts-expect-error Visible ranges are immutable.
range.start=2;
// @ts-expect-error Alignments use the documented union.
model.scrollToIndex(0,'middle');
const options:ApplicationPerformanceOptions={maxLoadTimeMs:1000,resourceBudgets:[{resource:'https://example.invalid/app.js',maxBytes:1000}],regressionBudgets:{javascriptBytes:{absolute:0,percent:10}}};
const report=assessApplicationPerformance({}, {requests:1,bodyBytes:1,javascriptBytes:1,cssBytes:1},options);
const duration:number=report.loadTimeMs;
const passed:boolean=report.policyChecks[0]!.passed;
// @ts-expect-error Only known measurements have regression budgets.
const invalid:ApplicationPerformanceOptions={regressionBudgets:{unknown:{absolute:0}}};
