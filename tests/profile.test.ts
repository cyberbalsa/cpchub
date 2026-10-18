import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/app';

const profile='/account/profile/';

test('profile name changes update existing creations and keep the same account',async()=>{
 const f=await fixture();try{
  f.insert('socialaccount_socialaccount',{id:1,provider:'steam',uid:'123',user_id:1,extra_data:'{}'});
  const item=await (await f.request('/api/v1/items/','POST',{title:'My creation',summary:'Summary',description:'Description',content_type:'blueprints'})).json() as {id:string};
  const before=await f.request(profile);assert.equal(before.status,200);
  assert.match(await before.text(),/You can change your name once every 30 days/);
  const revision=f.sqlite.prepare('SELECT revision FROM worker_cache_revision').get()!.revision;
  const response=await f.rawRequest(profile,{
   method:'POST',headers:{Cookie:'cpc_session=test-session','Content-Type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({action:'rename',username:'  Cafe\u0301 停車_42.-  ',csrfmiddlewaretoken:'test-csrf',user_id:'2'})
  });
  assert.equal(response.status,303);
  assert.equal(response.headers.get('Location'),profile+'?name_changed=1#profile-name');
  assert.deepEqual(await (await f.request('/api/v1/me/')).json(),{id:1,username:'Café 停車_42.-'});
  assert.equal((await (await f.request('/api/v1/items/'+item.id+'/')).json() as {author:string}).author,'Café 停車_42.-');
  assert.match(await (await f.request('/creators/1/')).text(),/Café 停車_42\.-/);
  assert.equal(f.sqlite.prepare('SELECT user_id FROM socialaccount_socialaccount WHERE id=1').get()!.user_id,1);
  assert.equal(f.sqlite.prepare('SELECT username FROM auth_user WHERE id=2').get()!.username,'Other');
  assert.equal(f.sqlite.prepare('SELECT revision FROM worker_cache_revision').get()!.revision,Number(revision)+1);
  const html=await (await f.request(profile+'?name_changed=1')).text();
  assert.match(html,/Name updated\./);
  assert.match(html,/You can change your name again on <time datetime="[^"]+">/);
  assert.match(html,/<input[^>]+name="username"[^>]+disabled/);
  assert.match(html,/<button[^>]+disabled[^>]*>Save name<\/button>/);
 }finally{f.close();}
});

test('invalid, taken and unchanged names do not use the monthly change',async()=>{
 const f=await fixture();try{
  for(const username of ['', '   ', 42, null, ['Name'], 'a'.repeat(151), 'Name\nName', '<script>alert(1)</script>']){
   const response=await f.request(profile,'POST',{action:'rename',username});
   assert.equal(response.status,400,String(username));
   const html=await response.text();assert.match(html,/id="name-error" role="alert"/);
   assert(!html.includes('<script>alert(1)</script>'));
  }
  const taken=await f.request(profile,'POST',{action:'rename',username:'Other'});
  assert.equal(taken.status,409);assert.match(await taken.text(),/That name is taken\./);
  const unchanged=await f.request(profile,'POST',{action:'rename',username:' Author '});
  assert.equal(unchanged.status,303);
  assert.deepEqual({...f.sqlite.prepare('SELECT username,username_changed_at FROM auth_user WHERE id=1').get()},{username:'Author',username_changed_at:null});
  assert.equal((await f.request(profile,'POST',{action:'rename',username:'A'.repeat(150)})).status,303);
 }finally{f.close();}
});

test('name changes require 30 full days, including across calendar months',async t=>{
 const start=Date.parse('2026-01-15T12:00:00Z'),next=Date.parse('2026-02-14T12:00:00Z');
 t.mock.timers.enable({apis:['Date'],now:start});
 const f=await fixture();try{
  f.sqlite.prepare('UPDATE worker_session SET expires_at=?').run(next+3600000);
  assert.equal((await f.request(profile,'POST',{action:'rename',username:'First name'})).status,303);
  for(const at of [Date.parse('2026-02-01T00:00:00Z'),next-1]){
   t.mock.timers.setTime(at);
   const response=await f.request(profile,'POST',{action:'rename',username:'Too soon'});
   assert.equal(response.status,409);
   assert.match(await response.text(),/February 14, 2026 at 12:00:00 UTC/);
   assert.equal(f.sqlite.prepare('SELECT username_changed_at FROM auth_user WHERE id=1').get()!.username_changed_at,start);
  }
  assert.equal((await f.request(profile,'POST',{action:'rename',username:'First name'})).status,303);
  assert.equal(f.sqlite.prepare('SELECT username_changed_at FROM auth_user WHERE id=1').get()!.username_changed_at,start);
  t.mock.timers.setTime(next);
  const html=await (await f.request(profile)).text();
  assert.doesNotMatch(html,/<input[^>]+name="username"[^>]+disabled/);
  assert.equal((await f.request(profile,'POST',{action:'rename',username:'Second name'})).status,303);
  assert.deepEqual({...f.sqlite.prepare('SELECT username,username_changed_at FROM auth_user WHERE id=1').get()},{username:'Second name',username_changed_at:next});
 }finally{f.close();}
});

test('concurrent name changes cannot bypass the cooldown',async()=>{
 const f=await fixture();try{
  const responses=await Promise.all(['First choice','Second choice'].map(username=>f.request(profile,'POST',{action:'rename',username})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[303,409]);
  const changed=f.sqlite.prepare('SELECT username,username_changed_at FROM auth_user WHERE id=1').get()!;
  assert(['First choice','Second choice'].includes(String(changed.username)));
  assert.equal(typeof changed.username_changed_at,'number');
 }finally{f.close();}
});

test('name changes require a browser session and a valid CSRF token',async()=>{
 const f=await fixture();try{
  const data={action:'rename',username:'Changed'};
  assert.equal((await f.request(profile,'POST',data,'key')).status,403);
  assert.equal((await f.request(profile,'POST',data,'anonymous')).status,403);
  const requests:Record<string,string>[]=[
   {'X-CSRFToken':'wrong'},
   {'X-CSRFToken':'test-csrf',Origin:'https://other.example'}
  ];
  for(const headers of requests)assert.equal((await f.rawRequest(profile,{method:'POST',headers:{Cookie:'cpc_session=test-session','Content-Type':'application/json',...headers},body:JSON.stringify(data)})).status,403);
  assert.equal(f.sqlite.prepare('SELECT username FROM auth_user WHERE id=1').get()!.username,'Author');
 }finally{f.close();}
});

test('linked accounts can still be removed during a name cooldown, keeping the last login',async()=>{
 const f=await fixture();try{
  for(const [id,provider] of [[1,'steam'],[2,'discord']] as const)f.insert('socialaccount_socialaccount',{id,provider,uid:String(id),user_id:1,extra_data:'{}'});
  assert.equal((await f.request(profile,'POST',{action:'rename',username:'Changed'})).status,303);
  const at=f.sqlite.prepare('SELECT username_changed_at FROM auth_user WHERE id=1').get()!.username_changed_at;
  assert.equal((await f.request(profile,'POST',{action:'unlink',account:1})).status,302);
  assert.equal((await f.request(profile,'POST',{account:2})).status,302);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM socialaccount_socialaccount WHERE user_id=1').get()!.count,1);
  assert.equal(f.sqlite.prepare('SELECT username_changed_at FROM auth_user WHERE id=1').get()!.username_changed_at,at);
 }finally{f.close();}
});
