import {createProjectCostClient, createProjectCostView, createProjectCostMcpTools, type ProjectCostRateCard, type ProjectCostMeasurement} from '@clank.run/framework/project-costs';
import {createProjectCostClient as rootClient, type PlatformProjectCostOptions} from '@clank.run/framework';
import type {ClankPlatformOptions} from '@clank.run/framework/platform';
const client=createProjectCostClient({timeoutMs:1000});
const tools=createProjectCostMcpTools<{nativePrincipal:string}>((context,request)=>{const identity:string=context.nativePrincipal;void [identity,request.headers];return client;});void tools;
const card:ProjectCostRateCard={id:'operator-v1',revision:1,currency:'USD',effectiveFrom:Date.UTC(2026,9,1),rates:{storageByteMilliseconds:{amountMinor:1,perUnits:1000},transferBytes:{amountMinor:1,perUnits:1000},runtimeMilliseconds:{amountMinor:1,perUnits:1000}}};
const measurement:ProjectCostMeasurement={source:'trusted-measurement',sourceRevision:'revision-1',periodStartedAt:Date.UTC(2026,9,1),observedUntil:Date.now(),meters:{storageByteMilliseconds:{units:null,complete:false},transferBytes:{units:'0',complete:true},runtimeMilliseconds:{units:'9007199254740993',complete:true}}};
const costs:PlatformProjectCostOptions={rateCards:[card],measure:async({projectId,signal})=>{const id:string=projectId;signal.throwIfAborted();void id;return measurement;}};
declare const platform:ClankPlatformOptions;
platform.projectCosts=costs;
client.read('project_exact_01','2026-10').then(report=>{const amount:string|null=report.snapshot?.amountMinor??null;void amount;});
rootClient().history('project_exact_01','2026-10');
client.reconcile('project_exact_01',{month:'2026-10',expectedVersion:0,operationId:'exact_reconcile_01',reason:'Reviewed measured correction'});
client.policy('project_exact_01',{expectedVersion:0,operationId:'exact_policy_01',currency:'USD',limitMinor:'100',warningPercent:80,admission:'observe',maxMeasurementAgeMs:60000,reason:'Reviewed budget'});
client.override('project_exact_01',{expectedVersion:0,policyVersion:1,operationId:'exact_override_01',expiresAt:Date.now()+1000,reason:'Bounded recovery'});
declare const element:HTMLElement;
const view=createProjectCostView(element,{client,projectId:'project_exact_01',getAccountId:()=> 'human_exact_01',canManage:()=>true});const pending:boolean=view.hasPendingChanges();const disposed:boolean=view.disposed;void [pending,disposed];view.dispose();
// @ts-expect-error Browser reconciliation cannot supply or fabricate measured usage.
client.reconcile('project_exact_01',{month:'2026-10',expectedVersion:0,operationId:'changed_input_01',reason:'Reviewed',meters:{transferBytes:'0'}});
// @ts-expect-error Version-fenced policy changes are mandatory.
client.policy('project_exact_01',{operationId:'exact_policy_02',currency:'USD',limitMinor:'100',warningPercent:80,admission:'observe',maxMeasurementAgeMs:60000,reason:'Reviewed'});
// @ts-expect-error Quantities above Number precision use exact decimal strings.
const wrong:ProjectCostMeasurement={...measurement,meters:{...measurement.meters,transferBytes:{units:100,complete:true}}};
// @ts-expect-error Invoice enforcement is not an observed-budget policy.
const invoice:typeof costs={...costs,admission:'guaranteed-invoice'};
void [wrong,invoice];
