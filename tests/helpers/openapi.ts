import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import assert from 'node:assert/strict';
export const spec=parse(readFileSync('public/openapi.yaml','utf8'));
const ajv=new Ajv2020({strict:false,allErrors:true});
addFormats(ajv);ajv.addFormat('binary',true);ajv.addFormat('int64',{type:'number',validate:Number.isSafeInteger});
ajv.addSchema({$id:'https://test.local/contract',components:spec.components});
export function validator(schema:any){return ajv.compile({...schema,components:spec.components});}
export function check(name:string,data:any){const validate=validator({$ref:'#/components/schemas/'+name});assert(validate(data),name+': '+JSON.stringify(validate.errors));}
export const covered=new Set<string>();
export async function checkResponse(path:string,method:string,response:Response):Promise<any>{
 const op=spec.paths[path]?.[method.toLowerCase()];assert(op,`Undocumented operation ${method} ${path}`);covered.add(method.toUpperCase()+' '+path);
 const responseSpec=op.responses[response.status];assert(responseSpec,`Undocumented status ${response.status} on ${method} ${path}: ${await response.clone().text()}`);
 const contract=responseSpec.$ref?spec.components.responses[responseSpec.$ref.split('/').at(-1)]:responseSpec;
 const contentType=response.headers.get('content-type')?.split(';')[0];
 if(contract.content){assert(contentType);const schema=contract.content[contentType]?.schema;assert(schema,`Undocumented media type ${contentType}`);if(contentType==='application/json'){const data=await response.clone().json();const validate=validator(schema);assert(validate(data),`${method} ${path}: ${JSON.stringify(validate.errors)}`);return data;}}
 else assert.equal(await response.clone().text(),'');
}
