import {fileURLToPath} from 'node:url';
import path from 'node:path';import readline from 'node:readline';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(process.execPath,[path.join(root,'mcp/server.mjs')],{cwd:root,windowsHide:true}),pending=new Map(),notes=[];let seq=0;
const rl=readline.createInterface({input:child.stdout});let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));
rl.on('line',line=>{const r=JSON.parse(line);if(r.method){notes.push(r);return;}const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(r.error.message)):p.resolve(r.result);}});
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('RPC timeout '+method+' '+stderr)),45000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
const call=(name,args,meta)=>rpc('tools/call',{name,arguments:args,...(meta?{_meta:meta}:{})});
const text=r=>r.content[0].text,id=r=>/result_id=([a-f0-9]{24})/.exec(text(r))?.[1],next=r=>Number(/next_offset=(\d+)/.exec(text(r))?.[1]||0),body=r=>text(r).split('\n').slice(1).join('\n');
async function finish(resultId,offset=0){let r;for(let n=0;n<10;n++){r=await call('read_result',{result_id:resultId,offset,wait_ms:10000});offset=next(r);if(text(r).includes('state=completed'))return r;}throw Error('job did not finish');}
try {
 await rpc('initialize',{protocolVersion:'2025-06-18'});
 let r=await call('exec',{command:'printf WARM',yield_time_ms:30000});assert.equal(r.isError,false,text(r));assert.ok(body(r).includes('WARM'));console.log('PASS warmup');
 let started=Date.now();r=await call('exec',{command:'printf FIRST; sleep 2; printf SECOND; sleep 2; printf LAST; exit 7',yield_time_ms:100});assert.ok(Date.now()-started<1500);assert.match(text(r),/state=running/);const ref=id(r);let offset=next(r);assert.ok(body(r).includes('FIRST'));
 r=await call('read_result',{result_id:ref,offset,wait_ms:10000});offset=next(r);assert.ok(body(r).includes('SECOND'),text(r));assert.match(text(r),/state=running/);r=await finish(ref,offset);assert.equal(r.isError,true);assert.match(text(r),/exit=7 FAILED/);console.log('PASS live pages arrive before command exit and final failure remains visible');
 r=await call('exec',{command:"printf '\\344'; sleep .4; printf '\\270\\255'; sleep .4; printf '\\360\\237'; sleep .4; printf '\\231\\202'; sleep 1",yield_time_ms:100});const unicode=id(r);offset=next(r);let output=body(r).startsWith('(')?'':body(r);
 for(let n=0;n<10;n++){r=await call('read_result',{result_id:unicode,offset,wait_ms:10000});offset=next(r);output+=body(r);if(text(r).includes('state=completed'))break;}assert.equal(output,'中🙂');console.log('PASS split UTF-8 live pages never advance over incomplete characters');
 r=await call('exec',{command:'printf STARTED; sleep 30',yield_time_ms:100});const cancel=id(r);r=await call('cancel_exec',{result_id:cancel});assert.match(text(r),/cancelling/);r=await finish(cancel);assert.equal(r.isError,true);assert.match(text(r),/CANCELLED/);console.log('PASS cancel_exec stops an already yielded job');
 const first=await call('exec',{command:'sleep 30',yield_time_ms:0}),queued=await call('exec',{command:'printf MUST_NOT_RUN',yield_time_ms:0});
 r=await call('read_result',{result_id:id(queued),wait_ms:0});assert.match(text(r),/state=queued/);
 await call('cancel_exec',{result_id:id(queued)});r=await finish(id(queued));assert.match(text(r),/CANCELLED/);assert.doesNotMatch(text(r),/CHANNEL-FAILED|MUST_NOT_RUN/);
 r=await call('read_result',{result_id:id(first),wait_ms:0});assert.ok(!text(r).includes('state=completed'));await call('cancel_exec',{result_id:id(first)});await finish(id(first));console.log('PASS queued cancellation never interrupts the other running task');
 r=await call('exec',{command:'sleep 30',timeout:1,yield_time_ms:0});r=await finish(id(r));assert.equal(r.isError,true);assert.match(text(r),/TIMED-OUT/);console.log('PASS background execution timeout preserves final error state');
 const before=notes.length;r=await call('exec',{command:'printf PROGRESS1; sleep 1; printf PROGRESS2; sleep 1',yield_time_ms:3000},{progressToken:'live-check'});assert.equal(r.isError,false,text(r));const updates=notes.slice(before).filter(n=>n.method==='notifications/progress');assert.ok(updates.length>0);assert.ok(updates.every((n,i)=>n.params.progressToken==='live-check' && (!i || n.params.progress>updates[i-1].params.progress)));assert.ok(updates.some(n=>n.params.message.includes('PROGRESS')));console.log('PASS bounded MCP progress notifications before final response');
} finally {child.stdin.end();rl.close();setTimeout(()=>child.kill(),1500).unref();}
