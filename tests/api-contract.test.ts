import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/app';
import {spec,checkResponse,covered} from './helpers/openapi';
import {hash,uuid,now} from '../src/env';

test('all API and OAuth features return their documented response datatypes',async()=>{
 const f=await fixture();try{
 const call=async(path:string,method='GET',data?:unknown,contract=path)=>{const response=await f.request(path,method,data);assert(response.status<400,`${method} ${path}: ${response.status} ${await response.clone().text()}`);return checkResponse(contract,method,response);};
 await call('/api/v1/me/');await call('/api/v1/types/');await call('/api/v1/types/blueprints/','GET',undefined,'/api/v1/types/{slug}/');await call('/api/v1/tags/');await call('/api/v1/tags/suggest/');
 const item=await call('/api/v1/items/','POST',{title:'Contract test',summary:'Summary',description:'Description',content_type:'blueprints',tags:'parking'});
 const base='/api/v1/items/'+item.id+'/',pattern='/api/v1/items/{id}/';
 await call('/api/v1/items/');await call(base,'GET',undefined,pattern);await call(base,'PATCH',{title:'Updated'},pattern);
 await call(base+'history/','GET',undefined,pattern+'history/');
 for(const [kind,field,name]of [['releases','file','test.cpbp'],['screenshots','image','test.png']]){const form=new FormData();form.set(field,new File(['test'],name));form.set('version','1.0');await call(base+kind+'/','POST',form,pattern+kind+'/');}
 await call(base+'upload-jobs/','GET',undefined,pattern+'upload-jobs/');
 const release=uuid(),shot=uuid(),itemId=item.id.replaceAll('-','');
 f.insert('hub_release',{id:release,item_id:itemId,version:'0.1',file:'test.cpbp',original_filename:'test.cpbp',file_stats:'{}',sha256:'a'.repeat(64),size:4});f.objects.set('test.cpbp',new TextEncoder().encode('test'));
 f.insert('hub_screenshot',{id:shot,item_id:itemId,image:'legacy.webp'});f.objects.set('legacy.webp',new TextEncoder().encode('test'));
 await call(base+'releases/'+release+'/download/','GET',undefined,pattern+'releases/{release_id}/download/');
 await call(base+'screenshots/'+shot+'/image/','GET',undefined,pattern+'screenshots/{screenshot_id}/image/');
 await call(base+'screenshots/'+shot+'/','DELETE',undefined,pattern+'screenshots/{screenshot_id}/');
 await call(base,'DELETE',undefined,pattern);await call(base+'restore/','POST',{},pattern+'restore/');
 const key=await call('/api/v1/keys/','POST',{name:'Contract key',scopes:['read'],days:7});await call('/api/v1/keys/');await call('/api/v1/keys/'+key.id+'/','DELETE',undefined,'/api/v1/keys/{id}/');
 f.insert('oauth2_provider_application',{id:1,client_id:'test-client',client_type:'public',authorization_grant_type:'authorization-code',redirect_uris:'https://example.com/callback',name:'Test Manager'});
 const verifier='a'.repeat(43),challenge=Buffer.from(await hash(verifier),'hex').toString('base64url');
 const authorize={client_id:'test-client',redirect_uri:'https://example.com/callback',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,state:'random-state',scope:'read write keys:write'};
 await call('/o/authorize/?'+new URLSearchParams(authorize),'GET',undefined,'/o/authorize/');
 const consent=await f.request('/o/authorize/','POST',{...authorize,approve:'yes'});await checkResponse('/o/authorize/','POST',consent);const redirect=new URL(consent.headers.get('Location')!);assert.equal(redirect.searchParams.get('state'),'random-state');
 const tokens=await call('/o/token/','POST',{grant_type:'authorization_code',client_id:'test-client',redirect_uri:authorize.redirect_uri,code:redirect.searchParams.get('code'),code_verifier:verifier});assert.equal(tokens.expires_in,3600);
 const replay=await f.request('/o/token/','POST',{grant_type:'authorization_code',client_id:'test-client',redirect_uri:authorize.redirect_uri,code:redirect.searchParams.get('code'),code_verifier:verifier});assert.equal(replay.status,400);await checkResponse('/o/token/','POST',replay);
 const rotated=await call('/o/token/','POST',{grant_type:'refresh_token',client_id:'test-client',refresh_token:tokens.refresh_token});
 const refreshReplay=await f.request('/o/token/','POST',{grant_type:'refresh_token',client_id:'test-client',refresh_token:tokens.refresh_token});assert.equal(refreshReplay.status,400);await checkResponse('/o/token/','POST',refreshReplay);
 await call('/o/revoke_token/','POST',{client_id:'test-client',token:rotated.access_token});
 assert.deepEqual([...covered].sort(),Object.entries<any>(spec.paths).flatMap(([path,methods])=>Object.keys(methods).map(method=>method.toUpperCase()+' '+path)).sort(),'Every documented feature must be exercised');
 }finally{f.close();}
});

test('developer examples include the configured domain and API docs do not loop',async()=>{
 const f=await fixture();try{
 for(const domain of ['https://cpchub.net','http://localhost:8787']){
  (f.env as any).PUBLIC_URL=domain;
  const response=await f.request('/developers/');assert.equal(response.status,200);const html=await response.text();assert(html.includes(`curl '${domain}/api/v1/items/`));assert(html.includes(`curl '${domain}/api/v1/me/`));assert(!html.includes('15 minutes'));assert(!html.includes('signed storage URLs'));
 }
 const docs=await f.request('/api/docs/');assert.equal(docs.status,200);assert((await docs.text()).includes('swagger-ui-bundle.js'));
 const schema=await f.request('/api/schema/');assert.equal(schema.status,200);assert((await schema.text()).includes('openapi: 3.1.0'));
 }finally{f.close();}
});

test('documented API key spelling, permissions and validation errors work end to end',async()=>{
 const f=await fixture();try{
 const me=await f.request('/api/v1/me/','GET',undefined,'key');assert.equal(me.status,200);await checkResponse('/api/v1/me/','GET',me);
 for(const days of [0,-1,91,1.5]){const response=await f.request('/api/v1/keys/','POST',{name:'Bad expiry',days});assert.equal(response.status,400);await checkResponse('/api/v1/keys/','POST',response);}
 for(const value of [null,[],42,'string']){const response=await f.request('/api/v1/items/','POST',value);assert.equal(response.status,400);await checkResponse('/api/v1/items/','POST',response);}
 const anonymous=await f.request('/api/v1/me/','GET',undefined,'anonymous');assert.equal(anonymous.status,401);await checkResponse('/api/v1/me/','GET',anonymous);
 const forbidden=await f.request('/api/v1/keys/','GET',undefined,'key');assert.equal(forbidden.status,403);await checkResponse('/api/v1/keys/','GET',forbidden);
 }finally{f.close();}
});

test('bearer authentication rejects malformed, expired, revoked and inactive credentials',async()=>{
 const f=await fixture();try{
 for(const prefix of ['Bearer','bearer','ApiKey','Api-Key'])assert.equal((await f.rawRequest('/api/v1/me/',{headers:{Authorization:prefix+' '+f.key}})).status,200);
 for(const value of [f.key,'Basic '+f.key,'Bearer invalid','Bearer a b']){const response=await f.rawRequest('/api/v1/me/',{headers:{Authorization:value}});assert.equal(response.status,401);assert.match(response.headers.get('WWW-Authenticate')!,/^Bearer /);await checkResponse('/api/v1/me/','GET',response);}
 f.sqlite.prepare('UPDATE hub_apikey SET expires_at=?').run('2000-01-01T00:00:00Z');assert.equal((await f.request('/api/v1/me/','GET',undefined,'key')).status,401);
 f.sqlite.prepare('UPDATE hub_apikey SET expires_at=NULL,revoked_at=?').run(now());assert.equal((await f.request('/api/v1/me/','GET',undefined,'key')).status,401);
 f.sqlite.exec('UPDATE hub_apikey SET revoked_at=NULL; UPDATE auth_user SET is_active=0 WHERE id=1');assert.equal((await f.request('/api/v1/me/','GET',undefined,'key')).status,401);
 }finally{f.close();}
});

test('CSRF comparison and malformed JSON fail with client errors',async()=>{
 const f=await fixture();try{
 for(const token of ['wrong','', 'test-csrf-extra']){
 const response=await f.rawRequest('/api/v1/keys/',{method:'POST',headers:{Cookie:'cpc_session=test-session','X-CSRFToken':token,'Content-Type':'application/json'},body:'{"name":"Key"}'});assert.equal(response.status,403);
 }
 const malformed=await f.rawRequest('/api/v1/items/',{method:'POST',headers:{Authorization:'Bearer '+f.key,'Content-Type':'application/json'},body:'{'});assert.equal(malformed.status,400);await checkResponse('/api/v1/items/','POST',malformed);
 const denied=await f.rawRequest('/api/v1/items/',{method:'POST',headers:{Cookie:'cpc_session=test-session','X-CSRFToken':'test-csrf',Origin:'https://other.example','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
 }finally{f.close();}
});

test('read-only keys cannot write; drafts stay private and filters validate integers',async()=>{
 const f=await fixture();try{
 const created=await f.request('/api/v1/items/','POST',{title:'Private draft',summary:'Summary',description:'Description',content_type:'scenarios'});const item=await created.json() as any;
 const privateRead=await f.request('/api/v1/items/'+item.id+'/','GET',undefined,'anonymous');assert.equal(privateRead.status,404);await checkResponse('/api/v1/items/{id}/','GET',privateRead);
 f.sqlite.exec(`UPDATE hub_apikey SET scopes='["read"]'`);
 const denied=await f.request('/api/v1/items/'+item.id+'/','PATCH',{title:'Changed'},'key');assert.equal(denied.status,403);await checkResponse('/api/v1/items/{id}/','PATCH',denied);
 for(const value of ['-1','1.5','NaN','Infinity','9007199254740992']){const response=await f.request('/api/v1/items/?min_width='+value);assert.equal(response.status,400);await checkResponse('/api/v1/items/','GET',response);}
 }finally{f.close();}
});

test('public, account and staff pages render without server errors',async()=>{
 const f=await fixture();try{
 f.sqlite.exec('UPDATE auth_user SET is_superuser=1 WHERE id=1');
 for(const path of ['/','/install/','/developers/','/donate/','/accounts/login/','/account/keys/','/account/profile/','/upload/','/moderation/','/moderation/tags/','/moderation/uploads/','/moderation/reviews/','/moderation/users/','/moderation/activity/','/admin/settings']){
  const response=await f.request(path);assert.equal(response.status,200,path+': '+(await response.clone().text()).slice(0,200));
 }
 }finally{f.close();}
});
