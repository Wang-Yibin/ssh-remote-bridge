import assert from 'node:assert/strict';
import * as engine from '../lib/engine.mjs';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

const srv=engine.getServer(process.argv[2]);
const run=(command,options={})=>engine.execOnSmart(srv,command,{timeout:30,...options});
let dir;
try {
  let r=await run('mktemp -d /tmp/srb-lifecycle.XXXXXXXXXX');
  dir=r.output.trim();assert.match(dir,/^\/tmp\/srb-lifecycle\.[A-Za-z0-9]+$/);
  const rex=engine.getExecFor(srv),pid=rex.proc.pid;
  r=await run('printf FRACTIONAL',{timeout:1.2345});assert.equal(r.output,'FRACTIONAL');assert.equal(rex.proc.pid,pid);
  const started=Date.now();
  for(let i=0;i<20;i++){r=await run('printf x');assert.equal(r.output,'x');assert.equal(rex.proc.pid,pid);}
  console.log('PASS 20 commands reuse one SSH client: '+(Date.now()-started)+' ms');

  const background=Date.now();
  r=await run('bash -c \'trap "" TERM; echo $$ > '+dir+'/background; sleep 30\' & sleep .1; printf FOREGROUND');
  assert.equal(r.output,'FOREGROUND');assert.ok(Date.now()-background<900);
  r=await run('sleep 2.1; read p < '+dir+'/background; ! kill -0 "$p" 2>/dev/null && printf REAPED');
  assert.equal(r.output,'REAPED');console.log('PASS ordinary completion cleans up TERM-resistant background children without delaying its result');

  // Disable the host deadline: the remote controller must enforce it independently.
  const timeout=rex._execOne('trap "" TERM; sleep 30',{timeout:1000});
  clearTimeout(rex.pending.get(rex.curToken).timer);
  r=await timeout;assert.equal(r.timedOut,true);assert.equal(r.interrupted,true);
  assert.ok(Number.isInteger(r.exitCode));console.log('PASS remote execution timeout survives removal of the host timer');

  r=await run("head -c 2500000 /dev/zero | tr '\\0' x",{isolated:true,maxOutputChars:16});
  assert.equal(r.truncated,true);assert.equal(r.outputBytes,2097152);assert.equal(r.exitCode,0);
  console.log('PASS 2 MiB capture limit drains excess output without failing the command');

  let notify;const launched=new Promise(resolve=>notify=resolve);
  const active=rex.exec('printf "%s %s" "$PPID" "$$" > '+dir+'/pids; sleep 30',{retained:true,onStart:notify});
  const activeFailure=active.catch(error=>error);
  await launched;
  const queued=rex.exec('touch '+dir+'/MUST_NOT_RUN');const queuedFailure=queued.catch(error=>error);
  const oldSession=rex.session;
  await new Promise(resolve=>setTimeout(resolve,100));
  const closing=Date.now();await engine.closeAllPersist();
  assert.ok(await activeFailure instanceof Error);assert.ok(await queuedFailure instanceof Error);
  assert.equal(rex.proc,null);
  r=await run('read controller command < '+dir+'/pids; '
    +'test ! -e '+dir+'/MUST_NOT_RUN && test ! -d '+oldSession
    +' && ! kill -0 "$controller" 2>/dev/null && ! kill -0 "$command" 2>/dev/null && printf CLEAN');
  assert.equal(r.output,'CLEAN',r.error||r.output);
  console.log('PASS EOF closes SSH, reaps remote controller/task, removes session files and prevents queued side effects; close='+ (Date.now()-closing)+' ms including verification handshake');

  const cli=spawn(process.execPath,[engine.ROOT+'/remote-shell.mjs',srv.name,'--framed'],{cwd:engine.ROOT,windowsHide:true});
  let output='',error='';cli.stdout.on('data',b=>output+=b);cli.stderr.on('data',b=>error+=b);
  cli.stdin.end('printf EARLY_PIPE_INPUT\ncd /tmp\npwd\nexit\ntouch '+dir+'/AFTER_EXIT\n');
  const cliCode=await new Promise((resolve,reject)=>{cli.once('error',reject);cli.once('close',resolve);});
  assert.equal(cliCode,0,error);assert.match(output,/EARLY_PIPE_INPUT/);assert.match(output,/\n\/tmp\n/);
  r=await run('test ! -e '+dir+'/AFTER_EXIT && printf CLEAN');assert.equal(r.output,'CLEAN');
  console.log('PASS framed CLI retains early piped input, waits for its session and stops at exit');

  const mcp=spawn(process.execPath,[engine.ROOT+'/mcp/server.mjs'],{cwd:engine.ROOT,windowsHide:true});
  const lines=readline.createInterface({input:mcp.stdout});let response;
  const reply=new Promise(resolve=>response=resolve);mcp.stderr.on('data',()=>{});
  lines.on('line',line=>{const message=JSON.parse(line);if(message.id===1)response(message);});
  const closed=new Promise((resolve,reject)=>{mcp.once('error',reject);mcp.once('close',resolve);});
  try {
    mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'exec',arguments:{server:srv.name,command:'printf "%s %s" "$PPID" "$$" > '+dir+'/mcp-pids; printf STARTED; sleep 30',yield_time_ms:1000}}})+'\n');
    const message=await reply;assert.equal(message.result.isError,false,JSON.stringify(message));
    // The first response can precede SSH startup. Wait for the unique marker via our independent audit channel.
    for(let i=0;i<30;i++){r=await run('test -s '+dir+'/mcp-pids && printf READY');if(r.output==='READY')break;await new Promise(resolve=>setTimeout(resolve,300));}
    assert.equal(r.output,'READY');mcp.stdin.end();assert.equal(await closed,0);
    r=await run('read controller command < '+dir+'/mcp-pids; ! kill -0 "$controller" 2>/dev/null && ! kill -0 "$command" 2>/dev/null && printf CLEAN');
    assert.equal(r.output,'CLEAN');console.log('PASS MCP stdin EOF waits for cleanup of an active yielded task');
  } finally {lines.close();mcp.kill();}
} finally {
  if(dir && /^\/tmp\/srb-lifecycle\.[A-Za-z0-9]+$/.test(dir))await run('rm -rf -- '+dir);
  await engine.closeAllPersist();
}
