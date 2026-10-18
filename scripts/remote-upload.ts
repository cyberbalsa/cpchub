import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base='https://cpc-hub-serverless.kingjrwr.workers.dev';
const headers={'Cookie':'cpc_session='+process.env.TEST_SESSION,'X-CSRFToken':process.env.TEST_CSRF!};
let response=await fetch(base+'/api/v1/items/',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({title:'Migration validation check',summary:'Temporary private migration test',description:'Temporary private migration test',content_type:'scenarios',status:'draft'})});assert.equal(response.status,201,await response.clone().text());const item:any=await response.json();const path=base+'/api/v1/items/'+item.id+'/';
const file=new FormData();file.set('file',new File([readFileSync('/home/balsa/.local/share/Steam/steamapps/common/Car Park Capital/saves/scenarios/Tron.cpcs')],'Tron.cpcs'));file.set('version','test');response=await fetch(path+'releases/',{method:'POST',headers,body:file});assert.equal(response.status,202,await response.clone().text());
const image=new FormData();image.set('image',new File([readFileSync('/tmp/cpc-test-image.png')],'image.png',{type:'image/png'}));response=await fetch(path+'screenshots/',{method:'POST',headers,body:image});assert.equal(response.status,202,await response.clone().text());
let jobs:any[]=[];for(let n=0;n<60;n++){jobs=await (await fetch(path+'upload-jobs/',{headers})).json() as any[];if(jobs.every(j=>j.status!=='pending'))break;await new Promise(r=>setTimeout(r,1000));}
assert.equal(jobs.length,2);assert(jobs.every(j=>j.status==='passed'),JSON.stringify(jobs));assert.equal((await fetch(path)).status,404);
response=await fetch(path,{headers});const loaded:any=await response.json();assert.equal(loaded.releases[0].file_stats.width,512);assert.equal(loaded.status,'draft');
const downloaded=await fetch(loaded.releases[0].download_url.replace('https://cpchub.net',base),{headers});assert.equal(downloaded.status,200);const bytes=await downloaded.arrayBuffer();assert.equal(bytes.byteLength,556944);
console.log('PASS: deployed native and image validators, real Tron, R2 streaming, Queue completion, draft privacy, file download.');
