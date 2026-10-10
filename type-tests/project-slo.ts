import {createProjectSloClient,evaluateProjectSlo,validateProjectSloConfiguration,openPlatform,type ProjectSloConfiguration,type ProjectSloAssessment,type ProjectSloBucket} from '../src/index.ts';
const configuration:ProjectSloConfiguration={name:'Checkout',objective:{kind:'latency',maximumMs:500},targetBasisPoints:9900,windowMinutes:5,minimumRequests:100,burnThreshold:2,enabled:true};
const client=createProjectSloClient({headers:()=>({authorization:'Bearer fixture'}),timeoutMs:500});
const bucket:ProjectSloBucket={startedAt:300000,complete:true,requests:100,successful:98,completed:99,latency:[0,10,50,80,90,98,99]};
evaluateProjectSlo(configuration,[bucket],600000);validateProjectSloConfiguration(configuration);
client.create('project_exact_01',{configuration,operationId:'operation_exact_01'});
client.change('project_exact_01','policy_exact_01',{configuration,operationId:'operation_exact_02',expectedVersion:1});
client.read('project_exact_01','policy_exact_01').then((assessment:ProjectSloAssessment)=>{const ratio:number|null=assessment.evaluation.burnRate;void ratio;});
openPlatform({dataDirectory:'/tmp/fixture',publicUrl:'http://127.0.0.1:4200',slos:{maxPolicies:10,maxReceipts:100,maxBuckets:10000,heartbeatMs:1000}});
// @ts-expect-error Only declared exact histogram boundaries are accepted.
const wrongLatency:ProjectSloConfiguration={...configuration,objective:{kind:'latency',maximumMs:501}};
// @ts-expect-error A policy change needs the current expected version.
client.change('project_exact_01','policy_exact_01',{configuration,operationId:'operation_exact_02'});
// @ts-expect-error Unknown windows cannot be claimed complete.
const wrongWindow:ProjectSloConfiguration={...configuration,windowMinutes:30};
// @ts-expect-error Counts require all seven cumulative latency boundaries.
const wrongBucket:ProjectSloBucket={...bucket,latency:[1,2]};
void wrongLatency;void wrongWindow;void wrongBucket;
