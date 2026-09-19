import type {SQLiteInternal} from "./sqlite-internal.js";
export interface SecretRotation { readonly id:string;readonly name:string;readonly state:string;readonly revision:string;readonly validation:string|null;readonly createdAt:number;readonly validatedAt:number|null; }
export interface SecretRevision { readonly name:string;readonly revision:string|null; }
export interface SecretRotationManager {
 stage(projectId:string,name:string,value:string):SecretRotation;
 validate(projectId:string,id:string):Promise<SecretRotation>;
 activate(projectId:string,id:string):SecretRotation;
 rollback(projectId:string,id:string):SecretRotation;
 list(projectId:string):readonly SecretRotation[];
 revisions(projectId:string,values?:Readonly<Record<string,string>>):readonly SecretRevision[];
}
export interface SecretRotationOptions { encrypt(value:string):string;decrypt(value:string):string;validate?:(input:{projectId:string;name:string;value:string;signal:AbortSignal})=>Promise<boolean>; }
export declare function openSecretRotations(sql:SQLiteInternal,options:SecretRotationOptions):Promise<SecretRotationManager>;
