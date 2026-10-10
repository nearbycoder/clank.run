import {createCustomerStatusClient,openPlatform,type CustomerStatusConfiguration,type CustomerStatusPublication,type CustomerStatusSnapshot} from '../src/index.ts';
import {validateCustomerStatusSnapshot} from '../src/customer-status.ts';
const configuration:CustomerStatusConfiguration={slug:'customer-health',title:'Health',description:'',components:[{key:'checkout',label:'Checkout',source:{kind:'slo',policyId:'native_policy_01',expectedVersion:1}}]};
const client=createCustomerStatusClient({url:'https://platform.example.test',timeoutMs:100});
client.create('native_project_01',{configuration,operationId:'native_create_01'});
const publication:CustomerStatusPublication={kind:'update',copy:{title:'Recovering',message:'Retry shortly',state:'monitoring',components:['checkout']},incident:{id:'private_incident_01',expectedVersion:1}};
client.preview('native_project_01',{expectedVersion:1,publication});
client.subscribe('customer-health',{subscribed:true,components:[],expectedVersion:0,operationId:'native_subscriber_01'});
client.publicPage('customer-health').then((page:CustomerStatusSnapshot)=>validateCustomerStatusSnapshot(page));
openPlatform({dataDirectory:'/tmp/fixture',publicUrl:'http://127.0.0.1:4200',statusPages:{maxPages:10,maxNotifications:1000}});
// @ts-expect-error A public update never accepts a private incident object as copy.
const wrongCopy:CustomerStatusPublication={kind:'update',copy:{title:'Private',message:'Private',state:'monitoring',components:[],privateNotes:'secret'},incident:null};
// @ts-expect-error Public health does not contain native tenant identities.
const wrongPage:CustomerStatusSnapshot={protocol:'clank-customer-status/1',slug:'customer-health',title:'Health',description:'',components:[],updates:[],publishedAt:0,tenantId:'private'};
// @ts-expect-error Publishing requires the reviewed current digest and native preview identifier.
client.publish('native_project_01',{expectedVersion:1,operationId:'native_publish_01'});
// @ts-expect-error Subscribers cannot choose an external delivery provider.
client.subscribe('customer-health',{subscribed:true,components:[],expectedVersion:0,operationId:'native_subscriber_01',channel:'email'});
void wrongCopy;void wrongPage;
