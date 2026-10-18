import {UploadedFile} from './multipart';
import {createHash} from 'node:crypto';
import {Env,User,Row,one,all,run,now,uuid,publicId,dbId,HttpError,hash} from './env';
export async function submit(env:Env,u:User,item:Row,file:File|UploadedFile,kind:'release'|'screenshot',data:Row){
 const setting=await one(env.DB,'SELECT max_file_mb FROM hub_uploadsettings WHERE id=1');const max=kind==='screenshot'?10*1024*1024:(setting?.max_file_mb||15)*1024*1024;
 if(!file||!file.size||file.size>max)throw new HttpError(400,'File exceeds the upload size limit.');
 const name=file.name.split(/[\\/]/).pop()!.slice(0,255);const ext=item.type_slug==='blueprints'?'.cpbp':'.cpcs';
 if(kind==='release'&&!name.toLowerCase().endsWith(ext))throw new HttpError(400,'Incorrect native file extension.');
 const version=String(data.version||'').trim();if(kind==='release'&&!/^[a-zA-Z0-9][a-zA-Z0-9._+ -]{0,39}$/.test(version))throw new HttpError(400,'Invalid version.');
 const metadata={version,game_version:String(data.game_version||'').slice(0,40),changelog:String(data.changelog||'').slice(0,10000),caption:String(data.caption||'').slice(0,180),type:item.type_slug};
 const id=uuid(),key=file instanceof UploadedFile?file.key:'incoming/'+id;let digest:string;if(file instanceof UploadedFile)digest=file.digest;else{const buffer=await file.arrayBuffer();digest=await hash(buffer);await env.QUARANTINE.put(key,buffer);}
 try{await env.DB.batch([
  env.DB.prepare("INSERT INTO hub_uploadjob(id,kind,status,original_filename,size,sha256,metadata,error,created_at,completed_at,item_id,release_id,screenshot_id,submitted_by_id) VALUES (?,?,'pending',?,?,?,?,'',?,NULL,?,NULL,NULL,?)").bind(id,kind,name,file.size,digest,JSON.stringify(metadata),now(),item.id,u.id),
  env.DB.prepare('INSERT INTO worker_job(id,object_key) VALUES (?,?)').bind(id,key),
  env.DB.prepare("UPDATE hub_item SET publish_after_validation=CASE WHEN status='published' THEN 1 ELSE publish_after_validation END,status='draft' WHERE id=?").bind(item.id)
 ]);}catch(e){await env.QUARANTINE.delete(key);const message=String(e);if(message.includes('upload_quota'))throw new HttpError(429,'16 uploads per hour. Try again later.');if(message.includes('queue_full'))throw new HttpError(503,'Upload queue is full.');if(message.includes('screenshot_limit'))throw new HttpError(400,'Maximum eight screenshots.');if(message.includes('duplicate_version'))throw new HttpError(400,'Version already exists.');throw e;}
 // D1 is also the outbox: cron resends if queue publication fails.
 await env.UPLOADS.send({id}).catch(()=>{});return jobJSON((await one(env.DB,'SELECT * FROM hub_uploadjob WHERE id=?',id))!);
}
export function jobJSON(j:Row){return {id:publicId(j.id),kind:j.kind,status:j.status,get_status_display:j.status==='pending'?'Checking':j.status==='passed'?'Passed':'Failed',original_filename:j.original_filename,error:j.error,release:j.release_id?publicId(j.release_id):null,screenshot:j.screenshot_id?publicId(j.screenshot_id):null,created_at:j.created_at,completed_at:j.completed_at};}
export async function processJob(env:Env,id:string){
 const j=await one(env.DB,"SELECT j.*,w.object_key,w.output_key FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id WHERE j.id=? AND j.status='pending'",id);if(!j)return;
 const claimed=await run(env.DB,'UPDATE worker_job SET lease_until=?,attempts=attempts+1 WHERE id=? AND lease_until<?',Date.now()+180000,id,Date.now());if(!claimed.meta.changes)return;
 const item=await one(env.DB,'SELECT * FROM hub_item WHERE id=? AND deleted_at IS NULL',j.item_id);
 if(!item){await failJob(env,j,'Creation was deleted.');return;}
 const object=await env.QUARANTINE.get(j.object_key);if(!object){await failJob(env,j,'Upload is missing. Please upload again.');return;}
 const m=JSON.parse(j.metadata),screenshot=j.kind==='screenshot';const service=screenshot?env.IMAGE_VALIDATOR:env.VALIDATOR;
 try{
  const response=await service.fetch('https://validator/validate',{method:'POST',body:object.body,headers:{'x-kind':m.type==='blueprints'?'blueprint':'scenario','x-size':String(j.size)}});
  if(response.status===422){await failJob(env,j,'File failed validation or exceeds the supported resource limits.');return;}
  if(!response.ok)throw new Error('Validator unavailable');
  let outputKey=screenshot?'':'releases/'+j.item_id+'/'+id+(m.type==='blueprints'?'.cpbp':'.cpcs');
  let stats:Row={};if(screenshot){const b=await response.arrayBuffer();if(!b.byteLength||b.byteLength>8*1024*1024)throw Error('Invalid result');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-512',b))].map(x=>x.toString(16).padStart(2,'0')).join('');outputKey=j.output_key||crypto.randomUUID()+'-'+digest.slice(-16)+'.webp';await run(env.DB,'UPDATE worker_job SET output_key=? WHERE id=?',outputKey,id);await env.PUBLIC_IMAGES.put(outputKey,b,{httpMetadata:{contentType:'image/webp',cacheControl:'public, max-age=300, s-maxage=86400'}});}else{
   stats=await response.json() as Row;const allowed=['schema_version','kind','format_version','width','height','depth','footprint_tiles','maps','entities','objects','object_types','parking_spaces','golf_cart_spaces','entrances','exits'];if(Object.keys(stats).some(k=>!allowed.includes(k))||stats.schema_version!==1||stats.kind!==(m.type==='blueprints'?'blueprint':'scenario')||!['width','height','depth'].every(k=>Number.isInteger(stats[k])&&stats[k]>=1&&stats[k]<=2048))throw Error('Invalid statistics');
   for(const [k,v] of Object.entries(stats))if(!['kind'].includes(k)&&v!==null&&(!Number.isSafeInteger(v)||v<0||v>163880482))throw Error('Invalid statistics');
   // Quarantine keys are immutable and inaccessible to clients; verify bytes again before promotion.
   const source=await env.QUARANTINE.get(j.object_key);if(!source)throw Error('Missing input');const digest=createHash('sha256');let size=0;const reader=source.body.getReader();while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;digest.update(r.value);}if(size!==j.size||digest.digest('hex')!==j.sha256){await failJob(env,j,'Upload integrity check failed.');return;}const approved=await env.QUARANTINE.get(j.object_key);if(!approved)throw Error('Missing approved input');await env.FILES.put(outputKey,approved.body,{httpMetadata:{contentType:'application/octet-stream'}});
  }
  const t=now();const statements=[];
  if(screenshot)statements.push(env.DB.prepare('INSERT OR IGNORE INTO hub_screenshot(id,image,caption,created_at,item_id) SELECT ?,?,?,?,id FROM hub_item WHERE id=? AND deleted_at IS NULL').bind(id,outputKey,m.caption,t,j.item_id));
  else statements.push(env.DB.prepare('INSERT OR IGNORE INTO hub_release(id,version,game_version,changelog,file,original_filename,sha256,size,downloads,created_at,item_id,file_stats) SELECT ?,?,?,?,?,?,?,?,0,?,id,? FROM hub_item WHERE id=? AND deleted_at IS NULL').bind(id,m.version,m.game_version,m.changelog,outputKey,j.original_filename,j.sha256,j.size,t,JSON.stringify(stats),j.item_id));
  statements.push(env.DB.prepare(`UPDATE hub_uploadjob SET status='passed',completed_at=?,${screenshot?'screenshot_id':'release_id'}=(SELECT id FROM ${screenshot?'hub_screenshot':'hub_release'} WHERE id=?) WHERE id=?`).bind(t,id,id));
  statements.push(env.DB.prepare('UPDATE worker_job SET output_key=? WHERE id=?').bind(outputKey,id));
  statements.push(env.DB.prepare("UPDATE hub_item SET content_revision=content_revision+1,updated_at=?,review_requested_at=? WHERE id=?").bind(t,t,j.item_id));
  statements.push(env.DB.prepare("UPDATE hub_item SET status='published',publish_after_validation=0 WHERE id=? AND publish_after_validation=1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM hub_uploadjob WHERE item_id=? AND status='pending') AND EXISTS(SELECT 1 FROM hub_release WHERE item_id=?) AND EXISTS(SELECT 1 FROM hub_screenshot WHERE item_id=?)").bind(j.item_id,j.item_id,j.item_id,j.item_id));
  await env.DB.batch(statements);await env.QUARANTINE.delete(j.object_key);
 }catch(e){await run(env.DB,'UPDATE worker_job SET lease_until=0 WHERE id=?',id);throw e;}
}
async function failJob(env:Env,j:Row,message:string){await env.DB.batch([env.DB.prepare("UPDATE hub_uploadjob SET status='failed',error=?,completed_at=? WHERE id=?").bind(message,now(),j.id),env.DB.prepare("UPDATE hub_item SET publish_after_validation=0,status='draft' WHERE id=?").bind(j.item_id)]);await env.QUARANTINE.delete(j.object_key);}
export async function maintenance(env:Env){
 const expired=await all(env.DB,"SELECT j.*,w.object_key,w.output_key FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id WHERE j.status='pending' AND j.created_at<?",new Date(Date.now()-15*60000).toISOString());for(const j of expired)await failJob(env,j,'Validation timed out. Please upload again.');
 const pending=await all(env.DB,"SELECT j.id FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id WHERE j.status='pending' AND w.lease_until<? LIMIT 64",Date.now());for(const j of pending)await env.UPLOADS.send({id:j.id});
 const deleted=await all(env.DB,'SELECT id FROM hub_item WHERE deleted_at<? LIMIT 20',new Date(Date.now()-14*86400000).toISOString());for(const i of deleted){const files=await all(env.DB,'SELECT file name FROM hub_release WHERE item_id=? UNION ALL SELECT image name FROM hub_screenshot WHERE item_id=?',i.id,i.id);await env.DB.batch([...files.map(f=>env.DB.prepare('INSERT OR IGNORE INTO hub_filedeletion(name,created_at) VALUES (?,?)').bind(f.name,now())),env.DB.prepare('DELETE FROM hub_item WHERE id=?').bind(i.id)]);}
 for(const f of await all(env.DB,'SELECT * FROM hub_filedeletion LIMIT 100')){if(/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-f0-9]{16})\.webp$/.test(f.name))await env.PUBLIC_IMAGES.delete(f.name);else await env.FILES.delete(f.name);await run(env.DB,'DELETE FROM hub_filedeletion WHERE id=?',f.id);}
 await env.DB.batch(['worker_session','worker_login','worker_nonce','worker_oauth_code','worker_token','worker_passkey_challenge'].map(t=>env.DB.prepare(`DELETE FROM ${t} WHERE expires_at<?`).bind(Date.now())));
 await run(env.DB,'DELETE FROM hub_accountactivity WHERE created_at<?',new Date(Date.now()-14*86400000).toISOString());
 await run(env.DB,'DELETE FROM hub_downloadip WHERE expires_at<?',now());await run(env.DB,'DELETE FROM hub_uploadevent WHERE created_at<?',new Date(Date.now()-86400000).toISOString());
}
