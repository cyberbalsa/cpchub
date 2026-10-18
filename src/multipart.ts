import Busboy from 'busboy';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {Env,Row,HttpError,uuid,one} from './env';
export class UploadedFile {constructor(readonly name:string,readonly size:number,readonly key:string,readonly digest:string){} }
export const isUpload=(value:any):value is File|UploadedFile=>value instanceof File||value instanceof UploadedFile;
const PART=5*1024*1024;
async function stage(env:Env,stream:Readable,name:string,limit:number):Promise<UploadedFile>{
 const key='incoming/'+uuid(),upload=await env.QUARANTINE.createMultipartUpload(key),parts:R2UploadedPart[]=[];const digest=createHash('sha256');let size=0,used=0,buffer=new Uint8Array(PART);
 try{for await(const chunk of stream){const bytes=chunk as Uint8Array;size+=bytes.length;if(size>limit)continue;digest.update(bytes);let at=0;while(at<bytes.length){const n=Math.min(PART-used,bytes.length-at);buffer.set(bytes.subarray(at,at+n),used);used+=n;at+=n;if(used===PART){parts.push(await upload.uploadPart(parts.length+1,buffer));buffer=new Uint8Array(PART);used=0;}}}
 if(size>limit)throw new HttpError(413,'File exceeds the upload size limit.');
 if((stream as any).truncated||!size)throw new HttpError(400,'Empty or oversized file.');if(used)parts.push(await upload.uploadPart(parts.length+1,buffer.subarray(0,used)));await upload.complete(parts);return new UploadedFile(name,size,key,digest.digest('hex'));
 }catch(e){await upload.abort().catch(()=>{});throw e;}
}
export async function multipart(request:Request,env:Env){
 if(!request.body)throw new HttpError(400,'Missing request body.');const setting=await one(env.DB,'SELECT max_file_mb FROM hub_uploadsettings WHERE id=1');const max=(setting?.max_file_mb||15)*1024*1024;
 const data:Row={},pending:Promise<void>[]=[],files:UploadedFile[]=[];let failure:unknown;
 const parser=Busboy({headers:Object.fromEntries(request.headers),limits:{files:9,fields:30,fieldSize:25000,headerPairs:100,fileSize:Math.max(max,10*1024*1024)}});
 const add=(name:string,value:any)=>{if(data[name]===undefined)data[name]=value;else if(Array.isArray(data[name]))data[name].push(value);else data[name]=[data[name],value];};
 parser.on('field',(name,value,info)=>{if(info.valueTruncated)failure=new HttpError(400,'Field too large.');add(name,value);});
 parser.on('file',(field,stream,info)=>{if(!['file','image','screenshots'].includes(field)){failure=new HttpError(400,'Unexpected file field.');stream.resume();return;}
 const task=stage(env,stream,info.filename||'upload',field==='file'?max:10*1024*1024).then(file=>{files.push(file);add(field,file);}).catch(e=>{failure=e;stream.resume();});pending.push(task);
 });
 for(const event of ['filesLimit','fieldsLimit','partsLimit'])parser.on(event,()=>{failure=new HttpError(413,'Too many upload fields.');});
 let received=0;const limited=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(b,c){received+=b.length;if(received>100*1024*1024)throw new HttpError(413,'Request too large.');c.enqueue(b);}}));
 try{await new Promise<void>((resolve,reject)=>{parser.on('close',resolve);parser.on('error',reject);Readable.fromWeb(limited as any).on('error',e=>{parser.destroy(e);reject(e);}).pipe(parser);});await Promise.all(pending);if(failure)throw failure;return {data,files};}
 catch(e){await Promise.all(pending);await Promise.all(files.map(f=>env.QUARANTINE.delete(f.key)));throw e instanceof HttpError?e:new HttpError(400,'Malformed multipart upload.');}
}
