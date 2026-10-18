export interface Env extends CloudflareBindings {
 CF_ANALYTICS_TOKEN: string; CF_BILLING_TOKEN: string; DISCORD_CLIENT_SECRET: string; STEAM_API_KEY: string;
}
export type Row = Record<string, any>;
export type User = Row & { id:number; username:string; role:string; is_authenticated:boolean; auth:'session'|'key'|'oauth'; scopes:string[]; csrf?:string; client_id?:string };
export type App = { Bindings:Env; Variables:{ user:User|null; uploadBody?:Row } };
export const now=()=>new Date().toISOString();
export const uuid=()=>crypto.randomUUID().replaceAll('-','');
export const publicId=(v:string)=>v.length===32?`${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`:v;
export const dbId=(v:string)=>v.replaceAll('-','');
export const one=async(db:D1Database,sql:string,...args:any[])=>db.prepare(sql).bind(...args).first<Row>();
export const all=async(db:D1Database,sql:string,...args:any[])=>(await db.prepare(sql).bind(...args).all<Row>()).results;
export const run=async(db:D1Database,sql:string,...args:any[])=>db.prepare(sql).bind(...args).run();
export class HttpError extends Error{constructor(public status:number,message:string){super(message);}}
export function requireUser(u:User|null): asserts u is User {if(!u)throw new HttpError(401,'Sign in to continue.');}
export function staff(u:User|null){return !!u&&u.auth==='session'&&!!u.role;}
export function manage(u:User|null){return staff(u)&&['Admin','Moderator'].includes(u!.role);}
export function admin(u:User|null){return staff(u)&&u!.role==='Admin';}
export function write(u:User|null){requireUser(u);if(u.auth!=='session'&&!u.scopes.includes('write'))throw new HttpError(403,'Write scope required.');}
export async function hash(value:string|ArrayBuffer){const b=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export const random=()=>crypto.randomUUID()+crypto.randomUUID();
