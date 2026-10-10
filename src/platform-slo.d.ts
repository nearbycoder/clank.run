import type {SQLiteInternal} from "./sqlite-internal.js";
import type {IngressRequestMetric} from "./data-plane.js";
import type {ProjectSloPolicy,ProjectSloAlert,ProjectSloAssessment} from "./project-slo.js";
export interface PlatformSloOptions {maxPolicies?:number;maxReceipts?:number;maxBuckets?:number;heartbeatMs?:number;}
export interface SloAuthority {readonly userId:string;authorize(write?:boolean):void;audit(action:string,metadata:Record<string,unknown>):void;}
export type StoredSloPolicy=ProjectSloPolicy;
export type StoredSloAlert=ProjectSloAlert;
export declare class ProjectSloError extends Error {readonly status:number;readonly code:string;constructor(status:number,code:string,message:string);}
export declare function openProjectSlos(sql:SQLiteInternal,options:PlatformSloOptions,hooks:{collecting:boolean;clock?:{wall():number;monotonic():number};manual?:boolean;onError?(error:unknown):void}):{
  pulse():boolean;record(metric:IngressRequestMetric):void;
  list(projectId:string,authority:SloAuthority):ProjectSloAssessment[];
  read(projectId:string,policyId:string,authority:SloAuthority):ProjectSloAssessment;
  create(projectId:string,authority:SloAuthority,value:unknown):StoredSloPolicy;
  change(projectId:string,policyId:string,authority:SloAuthority,value:unknown):StoredSloPolicy;
  alert(projectId:string,alertId:string):StoredSloAlert|null;
  start():void;close():void;
};
