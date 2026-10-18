// Limits calibrated against the user's Steam save; see docs/tron-baseline.json.
export const LIMITS={expanded:163880482,metadata:11836926,nodes:2208328,input:100*1024*1024,depth:32};
export class Invalid extends Error {}
const fail=(s:string):never=>{throw new Invalid(s);};
type V=any;
const td=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
// Projection parser: validate every CBOR value, retain only fields needed for stats.
// Large placement/entity arrays are reduced as they are read, never materialized.
export class CBOR {
 pos=0;nodes=0;
 constructor(readonly data:Uint8Array){}
 take(n:number){if(!Number.isSafeInteger(n)||n<0||n>this.data.length-this.pos)fail('invalid_metadata');const b=this.data.subarray(this.pos,this.pos+n);this.pos+=n;return b;}
 value(mode='skip',depth=0):V {
  if(++this.nodes>LIMITS.nodes)fail('metadata_values_limit');if(depth>LIMITS.depth)fail('metadata_depth_limit');
  const b=this.take(1)[0],major=b>>5,extra=b&31;
  if(major===7){if(extra===20||extra===21||extra===22)return extra===22?null:extra===21;
   if([25,26,27].includes(extra)){const n=extra===25?2:extra===26?4:8;const a=this.take(n);const v=new DataView(a.buffer,a.byteOffset,n);let f:number;if(n===2){const x=v.getUint16(0);const e=(x>>10)&31,m=x&1023;f=(x&32768?-1:1)*(e===0?m*2**-24:e===31?Infinity:(1+m/1024)*2**(e-15));}else f=n===4?v.getFloat32(0):v.getFloat64(0);if(!Number.isFinite(f))fail('invalid_metadata');return f;}return fail('invalid_metadata');}
  let n=extra;if(extra>=24){const len=({24:1,25:2,26:4,27:8} as Record<number,number>)[extra];if(!len)fail('invalid_metadata');n=0;for(const v of this.take(len))n=n*256+v;if(!Number.isSafeInteger(n))fail('invalid_metadata');}
  if(major===0)return n;if(major===1)return -1-n;
  if(major===2){this.take(n);return {type:'bytes',length:n};}
  if(major===3){const b=this.take(n);const s=td.decode(b);return mode==='skip'?{type:'string'}:s;}
  if(major!==4&&major!==5)fail('invalid_metadata');
  if(n*(major===5?2:1)>LIMITS.nodes-this.nodes)fail('metadata_values_limit');if(n>this.data.length-this.pos)fail('invalid_metadata');
  if(major===4){
   if(mode==='dimensions'&&n!==3)fail('invalid_dimensions');
   if(mode==='rooms'&&(n<1||n>16))fail('scenario_rooms');
   const out:V[]=[];const counts:Record<string,number>=Object.create(null);let known=true;
   for(let i=0;i<n;i++){const v=this.value(mode==='rooms'?'room':mode==='dimensions'?'scalar':mode==='entities'?'entity':'skip',depth+1);if(mode==='rooms'||mode==='dimensions')out.push(v);if(mode==='entities')known=addEntity(counts,v)&&known;}
   return mode==='rooms'||mode==='dimensions'?out:mode==='entities'?{type:'entities',length:n,counts:known?counts:null}:{type:'array',length:n};
  }
  const out:Record<string,V>=Object.create(null),counts:Record<string,number>=Object.create(null),keys=new Set<string>();let known=true;
  for(let i=0;i<n;i++){
   const k=this.value('key',depth+1);if(typeof k!=='string'&&!Number.isInteger(k))fail('invalid_metadata');const key=String(k);if(keys.has(key))fail('invalid_metadata');keys.add(key);
   let child='skip';
   if(mode==='blueprint')child=key==='size'||key==='tileMapSize'?'dimensions':key==='placedTemplates'?'placements':key==='name'?'scalar':'skip';
   if(mode==='scenario'&&key==='rooms')child='rooms';
   if(mode==='room')child=key==='tileMapSize'?'dimensions':key==='entities'?'entities':key==='scenario'?'shape':'skip';
   if(mode==='entity')child=key==='template'?'scalar':key==='components'?'components':'skip';
   if(mode==='entities')child='entity';
   const v=this.value(child,depth+1);
   if(child!=='skip')out[key]=v;
   if(mode==='components'&&key==='Placed')out.Placed=true;
   if(mode==='placements'){if(typeof k!=='string'||v?.type!=='array')known=false;else if(v.length)counts[key]=v.length;}
   if(mode==='entities')known=addEntity(counts,v)&&known;
  }
  if(mode==='placements')return {type:'placements',counts:known?counts:null};
  if(mode==='entities')return {type:'entities',length:n,counts:known?counts:null};
  return mode==='skip'||mode==='shape'?{type:'map',length:n}:out;
 }
}
function addEntity(counts:Record<string,number>,v:V){if(!v||typeof v!=='object'||Array.isArray(v)||v.type)return false;if(v.components!==undefined&&(!v.components||typeof v.components!=='object'||Array.isArray(v.components)||v.components.type))return false;if(v.components?.Placed){if(typeof v.template!=='string')return false;counts[v.template]=(counts[v.template]||0)+1;}return true;}
function metadata(b:Uint8Array,mode:string){const p=new CBOR(b);const obj=p.value(mode);if(p.pos!==b.length||!obj||typeof obj!=='object'||Array.isArray(obj)||obj.type)fail('invalid_metadata');return {obj,nodes:p.nodes};}
function dims(a:V):number[]{if(!Array.isArray(a)||a.length!==3||a.some(x=>!Number.isInteger(x)||x<1||x>2048))fail('invalid_dimensions');if(a[0]*a[1]*a[2]>128*1024*1024)fail('expanded_size_limit');return a;}
function stats(counts:Record<string,number>|null){const s:Record<string,number|null>={objects:counts?Object.values(counts).reduce((a,b)=>a+b,0):null,object_types:counts?Object.keys(counts).length:null};for(const [k,n] of Object.entries({parking_spaces:'ParkingBay',golf_cart_spaces:'GolfCartBay',entrances:'ParkingEntrance',exits:'ParkingExit'}))s[k]=counts?counts[n]||0:null;return s;}
class Reader {
 reader:ReadableStreamDefaultReader<Uint8Array>;chunk=new Uint8Array(0);pos=0;total=0;
 constructor(stream:ReadableStream<Uint8Array>,readonly limit:number){this.reader=stream.getReader();}
 async take(n:number){if(n>this.limit||n<0)fail('expanded_size_limit');const out=new Uint8Array(n);let at=0;while(at<n){if(this.pos===this.chunk.length){const r=await this.reader.read();if(r.done)fail('scenario_length');this.chunk=r.value as Uint8Array<ArrayBuffer>;this.pos=0;this.total+=r.value!.length;if(this.total>this.limit)fail('expanded_size_limit');}const len=Math.min(n-at,this.chunk.length-this.pos);out.set(this.chunk.subarray(this.pos,this.pos+len),at);this.pos+=len;at+=len;}return out;}
 async drain(){while(true){const r=await this.reader.read();if(r.done)break;this.total+=r.value!.length;if(this.total>this.limit)fail('expanded_size_limit');}return this.total;}
}
export async function validate(kind:string,stream:ReadableStream<Uint8Array>,length:number):Promise<Record<string,any>>{
 if(!Number.isSafeInteger(length)||length<1||length>LIMITS.input)fail('invalid_file');
 if(kind==='blueprint'){
  const r=new Reader(stream,LIMITS.input),h=await r.take(8),v=new DataView(h.buffer),version=v.getUint32(0,true),size=v.getUint32(4,true);
  if(![2,3].includes(version))fail('blueprint_version');if(size<1||size>LIMITS.metadata)fail('metadata_size_limit');const {obj,nodes}=metadata(await r.take(size),'blueprint');
  if(typeof obj.name!=='string'||obj.placedTemplates?.type!=='placements')fail('blueprint_metadata');const a=dims(obj.size),[x,y,z]=dims(obj.tileMapSize);if(a.some((v,i)=>v>[x,y,z][i]))fail('blueprint_metadata');const expected=8+size+2+3*x*y*z+x*z;if(expected>LIMITS.expanded)fail('expanded_size_limit');if(length!==expected||await r.drain()!==length)fail('blueprint_length');return {schema_version:1,kind:'blueprint',format_version:version,width:a[0],height:a[1],depth:a[2],footprint_tiles:a[0]*a[2],...stats(obj.placedTemplates.counts),_resources:{metadata:size,nodes,expanded:length}};
 }
 if(kind!=='scenario')fail('invalid_file');
 // Keep the native four-byte length trailer out of the strict zlib decoder.
 let tail=new Uint8Array(0),input=0;
 const compressed=stream.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,c){input+=chunk.length;if(input>length)fail('scenario_length');const b=new Uint8Array(tail.length+chunk.length);b.set(tail);b.set(chunk,tail.length);if(b.length>4)c.enqueue(b.subarray(0,b.length-4));tail=b.slice(-4);},flush(){if(input!==length||tail.length!==4)fail('scenario_trailer');}}));
 const r=new Reader(compressed.pipeThrough(new DecompressionStream('deflate')),LIMITS.expanded);
 try {
  const h=await r.take(8),size=Number(new DataView(h.buffer).getBigUint64(0,true));if(size<1||size>LIMITS.metadata)fail('metadata_size_limit');const {obj,nodes}=metadata(await r.take(size),'scenario');if(!Array.isArray(obj.rooms)||obj.rooms.length<1||obj.rooms.length>16)fail('scenario_rooms');
  let expected=size+8,width=0,height=0,depth=0,area=0,entities=0,counts:Record<string,number>|null=Object.create(null);
  for(const room of obj.rooms){if(room?.entities?.type!=='entities'||!['map','array'].includes(room?.scenario?.type))fail('scenario_metadata');const [x,y,z]=dims(room.tileMapSize);expected+=10+3*x*y*z+2*x*z;if(expected>LIMITS.expanded)fail('expanded_size_limit');width=Math.max(width,x);height=Math.max(height,y);depth=Math.max(depth,z);area+=x*z;entities+=room.entities.length;if(!room.entities.counts)counts=null;else if(counts)for(const [k,v] of Object.entries(room.entities.counts))counts[k]=(counts[k]||0)+(v as number);}
  const total=await r.drain();if(total!==expected)fail('scenario_length');if(new DataView(tail.buffer,tail.byteOffset,4).getUint32(0,true)!==total)fail('scenario_trailer');return {schema_version:1,kind:'scenario',format_version:null,width,height,depth,footprint_tiles:area,maps:obj.rooms.length,entities,...stats(counts),_resources:{metadata:size,nodes,expanded:total}};
 } finally {await r.reader.cancel().catch(()=>{});}
}
