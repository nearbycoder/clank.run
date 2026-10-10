import type {SQLiteInternal} from "./sqlite-internal.js";
import type {ProjectIncident,ProjectIncidentDetail,ProjectIncidentDiagnostics,ProjectIncidentOwner,ProjectIncidentPage} from "./project-incidents.js";
export interface PlatformIncidentOptions {
  maxIncidents?: number;
  maxReceipts?: number;
  diagnostics?: ProjectIncidentDiagnostics;
}
export interface IncidentAuthority {
  readonly userId: string;
  authorize(permission?: "read" | "logs" | "jobs"): void;
  mayRead(permission: "read" | "logs" | "jobs"): boolean;
  ownerAllowed(userId: string): boolean;
  owners(): readonly ProjectIncidentOwner[];
  audit(action: string, metadata: Record<string,unknown>): void;
}
export interface IncidentRelease { readonly id:string; readonly digest:string; readonly createdAt:number; readonly available:boolean; }
export declare class ProjectIncidentError extends Error {
  readonly status:number;
  readonly code:string;
  constructor(status:number,code:string,message:string);
}
export declare function openProjectIncidents(sql:SQLiteInternal,options:PlatformIncidentOptions,hooks:{release(projectId:string,releaseId:string):IncidentRelease|null;alert(projectId:string,id:string):{readonly state:"open"|"resolved";readonly observedAt:number}|null}):Promise<{
  close():void;
  owners(authority:IncidentAuthority):readonly ProjectIncidentOwner[];
  list(projectId:string,authority:IncidentAuthority,query:URLSearchParams):ProjectIncidentPage;
  create(projectId:string,authority:IncidentAuthority,value:unknown):ProjectIncident;
  change(projectId:string,id:string,authority:IncidentAuthority,value:unknown):Promise<ProjectIncident>;
  read(projectId:string,id:string,authority:IncidentAuthority,query:URLSearchParams):Promise<ProjectIncidentDetail>;
}>;
