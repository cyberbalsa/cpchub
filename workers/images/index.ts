// Only the application Worker has a service binding to this Worker. No storage or secrets.
interface Env { IMAGES: ImagesBinding }
export default {async fetch(request:Request,env:Env){
 if(request.method!=='POST'||!request.body)return new Response(null,{status:405});
 try{
  const size=Number(request.headers.get('x-size'));if(!Number.isSafeInteger(size)||size<1||size>10*1024*1024)throw Error();
  const chunks:Uint8Array[]=[];let total=0;const reader=request.body.getReader();while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>size){await reader.cancel();throw Error();}chunks.push(r.value);}if(total!==size)throw Error();
  const b=new Uint8Array(total);let offset=0;for(const c of chunks){b.set(c,offset);offset+=c.length;}
  const info=await env.IMAGES.info(new Blob([b]).stream());
  if(!('width' in info)||!['image/png','image/jpeg','image/webp','png','jpeg','webp'].includes(info.format)||info.width<320||info.height<180||info.width>8192||info.height>8192||info.width*info.height>20000000||info.width/info.height<1/6||info.width/info.height>6||('frames' in info&&Number(info.frames)>1))throw Error();
  // Detect animation in the actual container, not a filename or supplied MIME type.
  const text=(a:number,n:number)=>String.fromCharCode(...b.subarray(a,a+n));
  if(text(1,3)==='PNG'){for(let i=8;i+12<=b.length;){const n=new DataView(b.buffer).getUint32(i);if(text(i+4,4)==='acTL')throw Error();if(n>b.length-i-12)throw Error();i+=n+12;}}
  if(text(0,4)==='RIFF'){for(let i=12;i+8<=b.length;){const n=new DataView(b.buffer).getUint32(i+4,true),t=text(i,4);if(t==='ANIM'||t==='ANMF'||t==='VP8X'&&(b[i+8]&2))throw Error();if(n>b.length-i-8)throw Error();i+=8+n+(n%2);}}
  const result=await env.IMAGES.input(new Blob([b]).stream()).transform({width:1920,height:1080,fit:'scale-down'}).output({format:'image/webp',quality:88,anim:false});
  const response=result.response();const out=await response.arrayBuffer();if(out.byteLength>8*1024*1024)throw Error();return new Response(out,{headers:{'Content-Type':'image/webp'}});
 }catch{return Response.json({error:'image_unreadable'},{status:422});}
}};
