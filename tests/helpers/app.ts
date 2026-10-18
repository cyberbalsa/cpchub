import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../../src/index';
import {hash,uuid,now,type Env} from '../../src/env';

// Executes the application's real SQL and migrations. Remote storage/services are doubles.
export async function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync('migrations/'+file,'utf8'));
 function prepare(sql:string){let values:any[]=[];return {bind(...args:any[]){values=args;return this;},async first(){return sqlite.prepare(sql).get(...values)??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){const result=sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};}
 const db={prepare,async batch(statements:any[]){sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 function insert(table:string,values:Record<string,any>){
  const columns=sqlite.prepare(`PRAGMA table_info(${table})`).all() as any[];
  const row:Record<string,any>={};for(const c of columns)if(c.notnull&&c.dflt_value===null&&!Object.hasOwn(values,c.name))row[c.name]=/int|bool/i.test(c.type)?0:/date/i.test(c.type)?now():'';
  Object.assign(row,values);const keys=Object.keys(row);sqlite.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));return row;
 }
 insert('auth_user',{id:1,username:'Author',is_active:1});
 insert('auth_user',{id:2,username:'Other',is_active:1});
 sqlite.exec('UPDATE hub_tagsettings SET minimum_items=1 WHERE id=1');
 await db.prepare('INSERT INTO worker_session VALUES (?,?,?,?)').bind(await hash('test-session'),1,'test-csrf',Date.now()+3600000).run();
 const key='cpc_test_secret';insert('hub_apikey',{id:uuid(),user_id:1,name:'Test',prefix:'test',digest:await hash(key),scopes:'["read","write"]'});
 const objects=new Map<string,Uint8Array>();
 const bucket={async createMultipartUpload(key:string){const chunks:Uint8Array[]=[];return {async uploadPart(partNumber:number,bytes:Uint8Array){chunks[partNumber-1]=bytes.slice();return {partNumber,etag:'test'};},async complete(){const merged=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let at=0;for(const chunk of chunks){merged.set(chunk,at);at+=chunk.length;}objects.set(key,merged);},async abort(){objects.delete(key);}};},async put(key:string,value:any){objects.set(key,new Uint8Array(await new Response(value).arrayBuffer()));},async get(key:string){const bytes=objects.get(key);return bytes?{size:bytes.length,httpEtag:'"test"',body:new Response(bytes).body}:null;},async delete(key:string){objects.delete(key);}};
 const env={DB:db,PUBLIC_URL:'https://cpchub.net',SCREENSHOT_URL:'https://screenshots.cpchub.net',KOFI_PAGE_URL:'https://ko-fi.com/cpchub',FILES:bucket,QUARANTINE:bucket,PUBLIC_IMAGES:bucket,UPLOADS:{async send(){}},ASSETS:{async fetch(request:Request){return new Response(readFileSync('public'+new URL(request.url).pathname),{headers:{'Content-Type':'application/yaml'}});}}} as any as Env;
 const background:Promise<any>[]=[];
 const context={waitUntil(p:Promise<any>){background.push(p);},passThroughOnException(){}} as ExecutionContext;
 Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{async match(){},async put(){}}}});
 async function rawRequest(path:string,init:RequestInit){const response=await worker.fetch(new Request('https://cpchub.net'+path,init),env,context);await Promise.all(background.splice(0));return response;}
 async function request(path:string,method='GET',data?:unknown,auth:'session'|'key'|'anonymous'='session'){
  const headers=new Headers();if(auth==='session'){headers.set('Cookie','cpc_session=test-session');headers.set('X-CSRFToken','test-csrf');}else if(auth==='key')headers.set('Authorization','ApiKey '+key);
  let body:BodyInit|undefined;if(data instanceof FormData)body=data;else if(data!==undefined){headers.set('Content-Type','application/json');body=JSON.stringify(data);}
  const response=await worker.fetch(new Request('https://cpchub.net'+path,{method,headers,body}),env,context);await Promise.all(background.splice(0));return response;
 }
 return {sqlite,env,db,insert,request,rawRequest,objects,key,close:()=>sqlite.close()};
}
