import * as e from '../lib/engine.mjs';
import assert from 'node:assert/strict';
const srv=e.getServer(process.argv[2]);let dir;
const run=(c,o={})=>e.execOnSmart(srv,c,{timeout:30,...o});
try {
 let r=await run('printf READY');assert.equal(r.output,'READY',r.error);console.log('PASS handshake');
 const start=Date.now();r=await run('(sleep 1; printf LATE_BG)& printf FIRST',{stream:true});assert.equal(r.output,'FIRST');assert.ok(Date.now()-start<900);r=await run('sleep 1.2; printf SECOND',{stream:true});assert.equal(r.output,'SECOND');console.log('PASS background output cannot cross tasks');
 const t=Date.now();r=await run('sleep 1 & printf FIRST');assert.equal(r.output,'FIRST');assert.ok(Date.now()-t<900);console.log('PASS captured command does not wait for background EOF');
 r=await run('cd /tmp; export SRB_TEST_VAR=fromCLI');assert.equal(r.cwd,'/tmp');
 r=await run('printf "%s|%s" "$PWD" "${SRB_TEST_VAR-unset}"',{isolated:true,cwd:srv.remote});assert.equal(r.output,srv.remote+'|unset');assert.ok(r.resultId);console.log('PASS MCP task isolation and actual cwd');
 r=await run("printf 'HEAD'; head -c 200000 /dev/zero | tr '\\0' A; printf 'TAIL'; exit 7",{isolated:true,maxOutputChars:20});assert.equal(r.exitCode,7);assert.ok(r.output.startsWith('HEAD'));assert.ok(r.outputTail.endsWith('TAIL'));assert.ok(r.output.length+r.outputTail.length<=88);
 const page=await e.readResult(r.resultId,0,16);assert.equal(page.text,'HEAD'+'A'.repeat(12));assert.equal(page.exitCode,7);assert.equal(page.total_size,200008);console.log('PASS output budget before transmission and result pagination');
 r=await run('mktemp -d /tmp/srb-repair.XXXXXXXXXX');dir=r.output.trim();assert.match(dir,/^\/tmp\/srb-repair\.[A-Za-z0-9]+$/);
 await e.writeFileRemoteSmart(srv,dir+'/utf8','中文🙂END');r=await e.readFileRemoteSmart(srv,dir+'/utf8',4);assert.equal(r.text,'中');assert.equal(r.next_offset,3);assert.equal(r.truncated,true);r=await e.readFileRemoteSmart(srv,dir+'/utf8',7,{offset:3});assert.equal(r.text,'文🙂');console.log('PASS UTF-8 byte pages');
 const c=new AbortController();const pending=run('bash -c \'trap "" TERM; echo $$ > '+dir+'/child; sleep 30\' & wait',{signal:c.signal});setTimeout(()=>c.abort(),400);r=await pending;assert.equal(r.interrupted,true);r=await run('p=$(cat '+dir+'/child); if kill -0 "$p" 2>/dev/null; then ps -o stat= -p "$p"; else echo gone; fi');assert.match(r.output,/gone|Z/);console.log('PASS cancellation escalates the process group');
} finally {if(dir && /^\/tmp\/srb-repair\.[A-Za-z0-9]+$/.test(dir))await run('rm -rf -- '+dir);await e.closeAllPersist();}
