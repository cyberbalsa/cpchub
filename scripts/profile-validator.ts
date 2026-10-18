import {createReadStream,readFileSync} from 'node:fs';
import {Readable} from 'node:stream';
import {validate} from '../workers/validator/parser';
const path=process.argv[2];if(!path)throw Error('Pass a native .cpcs or .cpbp path');
const {size}=await import('node:fs/promises').then(fs=>fs.stat(path));
const start=process.memoryUsage();const t=performance.now();
const result=await validate(path.endsWith('.cpcs')?'scenario':'blueprint',Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,size);
console.log(JSON.stringify({result,ms:performance.now()-t,before:start,after:process.memoryUsage(),maxRSSKiB:process.resourceUsage().maxRSS},null,2));
