import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base='http://localhost:8787';
async function req(path:string,method='GET',data?:any,user?:number){const headers:Record<string,string>={};if(user){headers.Cookie='cpc_session=local-e2e-session-'+user;headers['X-CSRFToken']='local-e2e-csrf';}let body;if(data instanceof FormData)body=data;else if(data!==undefined){body=JSON.stringify(data);headers['Content-Type']='application/json';}const r=await fetch(base+path,{method,headers,body,redirect:'manual'});return r;}
const a=90001;
for(const p of ['/','/install/','/developers/','/donate/','/accounts/login/','/api/v1/types/']){const r=await req(p);assert.equal(r.status,200,p);}
for(const p of ['/upload/','/account/keys/','/account/profile/','/moderation/','/moderation/tags/','/moderation/uploads/','/moderation/reviews/','/moderation/users/','/moderation/activity/']){const r=await req(p,'GET',undefined,90002);assert.equal(r.status,200,p+': '+(await r.text()).slice(0,120));}
let r=await req('/api/v1/items/','POST',{title:'Migration test '+Date.now(),summary:'Round trip upload validation',description:'**Hello** from the Worker.',content_type:'scenarios',tags:'test, tron'},a);assert.equal(r.status,201,await r.clone().text());const item=await r.json() as any;const root='/api/v1/items/'+item.id+'/';
assert.equal((await req(root)).status,404,'draft must stay private');assert.equal((await req(root,'PATCH',{title:'Unauthorized'},90003)).status,404);
assert.equal((await req('/items/'+item.id+'/edit/','GET',undefined,a)).status,200);
const release=new FormData();const path='/home/balsa/.local/share/Steam/steamapps/common/Car Park Capital/saves/scenarios/Tron.cpcs';release.set('file',new File([readFileSync(path)],'Tron.cpcs'));release.set('version','1.0.0');r=await req(root+'releases/','POST',release,a);assert.equal(r.status,202,await r.clone().text());
const screenshot=new FormData();screenshot.set('image',new File([readFileSync('/tmp/cpc-test-image.png')],'image.png',{type:'image/png'}));r=await req(root+'screenshots/','POST',screenshot,a);assert.equal(r.status,202,await r.clone().text());
r=await req(root,'PATCH',{status:'published'},a);assert.equal(r.status,200,await r.clone().text());
let jobs:any[]=[];for(let attempt=0;attempt<40;attempt++){jobs=await (await req(root+'upload-jobs/','GET',undefined,a)).json() as any[];if(jobs.every(j=>j.status!=='pending'))break;await new Promise(r=>setTimeout(r,500));}
assert(jobs.every(j=>j.status==='passed'),JSON.stringify(jobs));r=await req(root);assert.equal(r.status,200);const published=await r.json() as any;assert.equal(published.status,'published');assert.match(published.screenshots[0].image_url,/https:\/\/screenshots\.cpchub\.net\/[a-f0-9-]{36}-[a-f0-9]{16}\.webp$/);
await new Promise(r=>setTimeout(r,100));r=await req(root);assert.equal(r.headers.get('X-Cache'),'HIT');assert.equal((await req(root,'GET',undefined,a)).headers.get('X-Cache'),'BYPASS');
assert.equal((await req('/items/'+item.id+'/')).status,200);assert.equal((await req('/moderation/items/'+item.id+'/','GET',undefined,90002)).status,200);
const download=published.releases[0].download_url.replace(base,'');r=await req(download);assert.equal(r.status,200);assert.equal(r.headers.get('X-Cache'),'BYPASS');await r.arrayBuffer();
r=await req(root,'PATCH',{status:'draft'},a);assert.equal(r.status,200);assert.equal((await req(root)).status,404,'edge cache invalidates immediately after unpublishing');
r=await req('/api/v1/keys/','POST',{name:'Test key',scopes:['read']},a);assert.equal(r.status,201,await r.clone().text());const key=await r.json() as any;r=await fetch(base+root,{headers:{Authorization:'Bearer '+key.key}});assert.equal(r.status,200);assert.equal(r.headers.get('X-Cache'),'BYPASS');
r=await fetch(base+root,{method:'PATCH',headers:{Authorization:'Bearer '+key.key,'Content-Type':'application/json'},body:'{"title":"No"}'});assert.equal(r.status,403);
r=await req(root,'DELETE',undefined,a);assert.equal(r.status,204);r=await req(root+'restore/','POST',{},a);assert.equal(r.status,200);
console.log('PASS: pages, auth boundaries, upload queue, native/image validation, publication, screenshot URL, edge cache, cache invalidation, downloads, scoped keys, delete/restore. Item:',item.id);
