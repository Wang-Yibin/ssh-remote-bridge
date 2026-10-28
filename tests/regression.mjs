import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'srb-regression-'));
const config=path.join(tmp,'servers.json');
const seed={host:'example.invalid',user:'testuser',password:'FAKE_ONLY',hostkey:'SHA256:FAKE',port:2222,remote:'/home/testuser'};
const save=servers=>fs.writeFileSync(config,JSON.stringify({servers}));
const source=f=>fs.readFileSync(path.join(root,f),'utf8');
const noProcess=()=>{throw new Error('unexpected subprocess in isolated test');};
function child() {
 const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();
 p.exitCode=null;p.signalCode=null;p.pid=12345;p.stdin.writable=true;p.stdin.end=()=>{};p.stdin.write=()=>true;p.kill=()=>{p.killed=true;return true;};return p;
}
const fakePersist=(exec=async()=>({exitCode:0,output:'',duration:0}))=>({getRemoteExec:()=>({exec,alive:false,pending:new Map()}),peekRemoteExec:()=>undefined,closeRemoteExec(){},closeAllRemoteExecs(){},StartError:class StartError extends Error{}});
async function load(entry,mocks={},options={}) {
 let stdout='',stderr='';
 const proc=Object.assign(new EventEmitter(),{env:{SRB_CONFIG:config,...options.env},execPath:options.execPath||process.execPath,platform:'win32',argv:options.argv||[process.execPath,path.join(root,entry)],cwd:()=>root,stdout:{write:s=>stdout+=s,isTTY:false},stderr:{write:s=>stderr+=s},exit:code=>{throw new Error('EXIT '+code);}});
 proc.stderr=Object.assign(new EventEmitter(),proc.stderr);
 const ctx=vm.createContext({process:proc,Buffer,console:options.console||console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,...options.globals});
 const modules=new Map();
 async function synthetic(key,values) {if(modules.has(key))return modules.get(key);const m=new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});modules.set(key,m);return m;}
 async function get(url) {
  if(modules.has(url))return modules.get(url);
  let text=fs.readFileSync(fileURLToPath(url),'utf8');
  if(url.endsWith('/mcp/server.mjs'))text=text.replace(/\nmain\(\);\s*$/,'\nexport {callTool,handleMessage};');
  if(url.endsWith('/remote-shell.mjs')&&!options.runEntry)text=text.slice(0,text.indexOf('if (process.argv[1] &&'))+'\nexport {main};';
  const m=new vm.SourceTextModule(text,{context:ctx,identifier:url,initializeImportMeta(meta){meta.url=url;}});modules.set(url,m);
  await m.link(async(spec,parent)=>{if(spec in mocks)return synthetic('mock:'+spec,mocks[spec]);if(spec==='node:child_process')return synthetic(spec,{spawn:noProcess,spawnSync:noProcess});if(spec==='ssh2')return synthetic(spec,{default:(await import(spec)).default});if(spec.startsWith('node:'))return synthetic(spec,await import(spec));return get(new URL(spec,parent.identifier).href);});return m;
 }
 const m=await get(pathToFileURL(path.join(root,entry)).href);await m.evaluate();return {ns:m.namespace,proc,output:()=>({stdout,stderr})};
}
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('01/03 repair and unmount cannot recurse, elevate or kill unrelated processes',()=>{
 const text=source('fix_stuck_drive.cmd')+source('umount_ssh-remote.cmd');
 assert.doesNotMatch(text,/RunAs|Start-Process|taskkill|Restart-Service|net session/i);
 assert.match(source('fix_stuck_drive.cmd'),/remount_all\.cmd/);
});
test('02 source and package do not embed credentials or log arguments',()=>{
 assert.doesNotMatch(source('tools/scan_package.py'),/_ENC|SELF_EXEMPT|base64\.b64decode/);
 assert.doesNotMatch(source('mcp/server.mjs'),/JSON.stringify\(params/);
 assert.ok(!JSON.parse(source('package.json')).files.includes('tools/'));
});
test('07 corrupt config stays byte-for-byte intact',async()=>{
 const text='{"servers":';fs.writeFileSync(config,text);
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});
 await assert.rejects(ns.saveServer({name:'new',...seed}),/invalid config/);
 assert.equal(fs.readFileSync(config,'utf8'),text);assert.ok(!fs.existsSync(config+'.lock'));
});
test('07 concurrent writers retain both profiles',async()=>{
 save({existing:seed});
 const spawn=()=>{const p=child();setTimeout(()=>{p.stderr.emit('data',Buffer.from('SHA256:FAKE\n'));p.emit('close',1);},20);return p;};
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(),'node:child_process':{spawn,spawnSync:noProcess}});
 await Promise.all(['alpha','beta'].map(name=>ns.saveServer({name,...seed,hostkey:null})));
 assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(config)).servers).sort(),['alpha','beta','existing']);
});
test('19 partial update retains auth and port, permits empty note and default=false',async()=>{
 save({existing:{...seed,note:'old',default:true}});const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});
 await assert.rejects(ns.saveServer({name:'existing',password:{bad:'type'}}),/must be a string/);
 await assert.rejects(ns.saveServer({name:'existing',isDefault:'false'}),/must be boolean/);
 await ns.saveServer({name:'existing',note:'',isDefault:false});
 const s=JSON.parse(fs.readFileSync(config)).servers.existing;
 assert.equal(s.port,2222);assert.equal(s.password,'FAKE_ONLY');assert.equal(s.note,'');assert.equal(s.default,false);
});
test('04/05 duplicate drives and injected mount path are rejected before mutation',async()=>{
 save({one:{...seed,drive:'M:'}});const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});
 await assert.rejects(ns.saveServer({name:'two',...seed,drive:'m:'}),/duplicate drive/);
 await assert.rejects(ns.saveServer({name:'one',mount:'C:\\audit" & echo BAD & rem "'}),/mount must/);
 assert.doesNotMatch(source('lib/engine.mjs'),/mklink \/D|rmdirSync/);
});
test('08 connection identity change closes old connection and busy change is refused',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{host:'old'});const p=child();re.proc=p;re.ready=true;
 re.updateConn({host:'new'});assert.equal(re.proc,null);assert.equal(re.conn.host,'new');
 re.pending.set('active',{});assert.throws(()=>re.updateConn({host:'other'}),/active/);re.pending.clear();
});

test('closing invalidates queued commands instead of reconnecting to run them',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('queue',{});
 let release,calls=0;re.chain=new Promise(r=>release=r);re.ensure=async()=>{calls++;};
 const pending=re.exec('must not run');const rejected=assert.rejects(pending,/closed/);
 await re.close();release();await rejected;assert.equal(calls,0);
 await assert.rejects(re.exec('still closed'),/closed/);
});

test('close waits for EOF cleanup and cancels its kill timer after normal exit',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('close',{}),p=child();re.proc=p;re.ready=true;
 let ended=false;p.stdin.end=()=>setTimeout(()=>{ended=true;p.exitCode=0;p.emit('exit',0,null);},10);
 const closing=re.close();assert.equal(ended,false);await closing;
 assert.equal(ended,true);assert.equal(p.killed,undefined);assert.equal(re.proc,null);
});

test('drop notification snapshots ready state before failing pending commands',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('drop',{});re.proc=child();re.ready=true;
 let drops=0;re.on('drop',()=>drops++);re.proc.exitCode=1;re._onExit(1,null);
 assert.equal(drops,1);assert.equal(re.alive,false);
});

test('failed spawns leave no child in the process-exit cleanup set',async()=>{
 const p=child();let kills=0;p.kill=()=>kills++;
 const {ns,proc}=await load('lib/persist.mjs',{'node:child_process':{spawn:()=>{queueMicrotask(()=>p.emit('error',Error('spawn failed')));return p;},spawnSync:noProcess}});
 await assert.rejects(new ns.RemoteExec('bad',{hostkey:'SHA256:FAKE'}).ensure(),/spawn failed/);
 const before=kills;proc.emit('exit');assert.equal(kills,before);
});

test('idle channels close without closing interactive channels or active work',async()=>{
 let tick;const {ns}=await load('lib/persist.mjs',{}, {globals:{setInterval:fn=>{tick=fn;return {unref(){}};},clearInterval(){}}});
 const re=new ns.RemoteExec('idle',{}),p=child();re.proc=p;re.ready=true;re.lastUsed=0;re.keepOpen=true;re._startKeepalive();
 tick();assert.equal(re.proc,p);re._onLine('D k1 0');
 re.keepOpen=false;re.queued=1;tick();assert.equal(re.proc,p);
 re.queued=0;tick();assert.equal(re.proc,null);assert.equal(re.closed,false);
 p.exitCode=0;p.emit('exit',0,null);
});

test('status lookup never constructs an executor or loads connection config',async()=>{
 let peeks=0;const mocked={...fakePersist(),getRemoteExec:()=>assert.fail('must not create'),peekRemoteExec:()=>{peeks++;}};
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':mocked});
 assert.equal(ns.sessionAlive({name:'unknown'}),false);assert.equal(ns.persistChannelStatus({name:'unknown'}).alive,false);assert.equal(peeks,2);
});
test('completion caches are isolated by executor/session and directory count is bounded',async()=>{
 let callsA=0,callsB=0;
 const a={session:'one',query:async()=>{callsA++;return {output:'toolA\nfileA\n'};}},b={session:'two',query:async()=>{callsB++;return {output:'toolB\nfileB\n'};}};
 const {ns}=await load('lib/complete.mjs',{'./engine.mjs':{getExecFor:s=>s.name==='a'?a:b}});
 const complete=(s,line)=>new Promise((resolve,reject)=>ns.makeCompleter(s)(line,(err,value)=>err?reject(err):resolve(value[0])));
 assert.ok((await complete({name:'a'},'tool')).includes('toolA'));
 assert.ok((await complete({name:'b'},'tool')).includes('toolB'));
 await complete({name:'a'},'tool');assert.equal(callsA,1);assert.equal(callsB,1);
 a.session='new';await complete({name:'a'},'tool');assert.equal(callsA,2);
 for(let i=0;i<65;i++)await complete({name:'a'},'cat dir'+i+'/f');
 const before=callsA;await complete({name:'a'},'cat dir0/f');assert.equal(callsA,before+1);
});

test('job shutdown before dispatch prevents any remote call and rejects new work',async()=>{
 let calls=0;const {ns}=await load('lib/jobs.mjs');const jobs=new ns.ExecJobs({execOnSmart:async()=>{calls++;return {exitCode:0};}});
 const j=jobs.start({name:'one'},'never',{cwd:'/tmp'});await jobs.close();
 assert.equal(calls,0);assert.equal(j.result.aborted,true);assert.equal(j.result.spawnFailed,false);
 assert.throws(()=>jobs.start({name:'one'},'never',{}),/shutting down/);
});

test('rclone uses an asynchronous child and cleans temporary credentials on success or setup failure',async()=>{
 for(const ok of [true,false]) {
  const conf=path.join(tmp,'rclone-test.conf');fs.writeFileSync(conf,'FAKE_ONLY');let spawned=0;
  const spawn=()=>{spawned++;const p=child();queueMicrotask(()=>p.emit('close',7));return p;};
  const {ns,proc}=await load('remote-shell.mjs',{'./lib/engine.mjs':{getServer:()=>({...seed,drive:'M:'}),rcloneExePath:()=>process.execPath,buildRcloneConf:()=>conf,umountServer:async()=>({ok,error:'setup failed'})},'node:child_process':{spawn,spawnSync:noProcess}},{argv:[process.execPath,path.join(root,'remote-shell.mjs'),'rclone','one']});
  if(ok){await ns.main();assert.equal(proc.exitCode,7);assert.equal(spawned,1);assert.equal(proc.listenerCount('SIGINT'),0);}
  else {await assert.rejects(ns.main(),/setup failed/);assert.equal(spawned,0);}
  assert.equal(fs.existsSync(conf),false);
 }
});

test('discovery limits simultaneous host probes and preserves profile order',async()=>{
 const servers=Array.from({length:7},(_,i)=>({...seed,name:String(i)}));let active=0,peak=0;
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{configState:()=>({ok:true,file:'fake'}),listServers:()=>servers,remoteToUnc:()=>'',serverMountStatus:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,3));active--;return {};}}});
 const result=await ns.callTool('list_servers',{});assert.equal(result.isError,false);assert.equal(peak,2);
 assert.deepEqual(JSON.parse(result.content[0].text).servers.map(s=>s.name),servers.map(s=>s.name));
});

test('framed parser joins many TCP fragments once and handles multiple lines',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('parse',{});re.proc=child();
 const pending=re._execOne('output'),token=re.curToken;
 const data=Buffer.from('O '+token+' '+Buffer.from('甲🙂'.repeat(3000)).toString('base64')+'\nD '+token+' 7\n');
 for(let i=0;i<data.length;i+=73)re._onData(data.subarray(i,i+73));
 assert.equal((await pending).output,'甲🙂'.repeat(3000));assert.equal(re.fragments.length,0);assert.equal(re.bufferedBytes,0);re.proc.exitCode=0;await re.close();
});

test('fractional execution deadlines serialize as integer milliseconds',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('timeout',{});re.proc=child();let line;
 re.proc.stdin.write=s=>{line=s;return true;};const pending=re._execOne('printf OK',{timeout:1234.5});
 assert.match(line,/ 1235\n$/);re._onLine('D '+re.curToken+' 0');await pending;re.proc.exitCode=0;await re.close();
 assert.throws(()=>re._execOne('invalid',{timeout:Infinity}),/timeout/);
});

test('12 late exit of old child cannot invalidate new child',async()=>{
 const children=[];const spawn=()=>{const p=child();children.push(p);p.stdin.write=line=>{const m=/\|C (w\d+)/.exec(line);if(m)queueMicrotask(()=>p.stdout.emit('data',Buffer.from('D '+m[1]+' 0\n')));return true;};return p;};
 const {ns}=await load('lib/persist.mjs',{'node:child_process':{spawn,spawnSync:noProcess}});
 const re=new ns.RemoteExec('x',{hostkey:'SHA256:FAKE'});await re.ensure();re.killProc();await re.ensure();
 const current=re.proc;children[0].emit('exit',0,null);assert.equal(re.proc,current);assert.equal(re.alive,true);re.close();
});
test('15 UTF-8 survives a split between every byte',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});re.proc=child();let streamed='';
 const result=re._execOne('echo',{stream:true,onStream:t=>streamed+=t});const token=re.curToken;
 for(const byte of Buffer.from('中文🙂\n'))re._onLine('S '+token+' '+Buffer.from([byte]).toString('base64'));
 re._onLine('D '+token+' 0');assert.equal((await result).output,'中文🙂\n');assert.equal(streamed,'中文🙂\n');re.close();
});
test('16 protocol memory is bounded and oversized frames close the connection',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});re.proc=child();
 const result=re._execOne('echo',{stream:true});const token=re.curToken;
 for(let i=0;i<80;i++)re._onLine('S '+token+' '+Buffer.alloc(32768,65).toString('base64'));
 assert.ok(re.pending.get(token).streamBytes<=ns.MAX_OUTPUT);
 re._onLine('D '+token+' 0');assert.equal((await result).truncated,true);
 const broken=re._execOne('bad');broken.catch(()=>{});re._onData(Buffer.alloc(ns.MAX_OUTPUT*2+1,65));await assert.rejects(broken,/killed/);assert.equal(re.proc,null);
});
test('17 cancelled queued request never executes',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});re.ensure=async()=>{};
 let release;re.chain=new Promise(r=>release=r);let executed=0;re._execOne=async()=>{executed++;return {};};
 const c=new AbortController();const pending=re.exec('danger',{signal:c.signal});c.abort();release();
 await assert.rejects(pending,/cancelled/);assert.equal(executed,0);
});
test('17 active cancellation sends only its token',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});const p=child();re.proc=p;re.ready=true;const lines=[];p.stdin.write=line=>{lines.push(line);return true;};
 const c=new AbortController();const pending=re.exec('sleep 20',{signal:c.signal});await new Promise(r=>setImmediate(r));const token=re.curToken;c.abort();
 assert.ok(lines.includes('X '+token+'\n'));re._onLine('D '+token+' 143');assert.equal((await pending).interrupted,true);re.close();
});
test('17 cancelling a handshake kills its child promptly',async()=>{
 const p=child();const {ns}=await load('lib/persist.mjs',{'node:child_process':{spawn:()=>p,spawnSync:noProcess}});
 const re=new ns.RemoteExec('cancel-start',{hostkey:'SHA256:FAKE'});const c=new AbortController();
 const pending=re.exec('never run',{signal:c.signal});await new Promise(r=>setImmediate(r));c.abort();
 await assert.rejects(pending,/handshake failed/);assert.equal(p.killed,true);assert.equal(re.pending.size,0);
});
test('18 completion uses bounded execution only while idle',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('query',{});re.proc=child();re.ready=true;
 let called;re.exec=async(cmd,opts)=>{called={cmd,opts};return {output:'OK'};};
 assert.equal((await re.query('pwd',{timeout:500})).output,'OK');assert.equal(called.opts.timeout,0.5);assert.match(called.cmd,/^\( pwd/);
 called=null;re.curToken='busy';assert.equal((await re.query('pwd')).output,'');assert.equal(called,null);re.close();
});
test('13 empty, binary and 64 KiB reads preserve bytes; invalid base64 fails',async()=>{
 save({one:seed});let output='0\n';const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(async()=>({exitCode:0,output,duration:0}))});
 const srv=ns.getServer('one');assert.equal((await ns.readFileRemoteSmart(srv,'/empty')).size,0);
 const bytes=Buffer.alloc(65536,255);output=bytes.length+'\n'+bytes.toString('base64');const r=await ns.readFileRemoteSmart(srv,'/binary');assert.equal(r.size,bytes.length);assert.equal(r.base64,bytes.toString('base64'));
 output='not base64!';assert.equal((await ns.readFileRemoteSmart(srv,'/bad')).ok,false);
 await assert.rejects(ns.readFileRemoteSmart(srv,'/bad',1.5),/integer/);
});
test('09 failures do not activate fallback or poison another profile',async()=>{
 save({one:seed,two:{...seed,host:'other.invalid'}});let calls=0;
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(async()=>{calls++;throw new Error('authentication failed');})});
 await ns.execOnSmart(ns.getServer('one'),'echo one');await ns.execOnSmart(ns.getServer('two'),'echo two');assert.equal(calls,2);
 assert.doesNotMatch(source('lib/engine.mjs'),/send-keys|capture-pane/);
});
test('14 nonzero exit, timeout, missing exit and channel failure all set MCP isError',async()=>{
 for(const result of [{done:true,exitCode:1},{done:true,exitCode:0,timedOut:true},{done:false,exitCode:null},{done:false,spawnFailed:true,exitCode:null}]){
  const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{getServer:()=>({name:'one',remote:'/home/testuser'}),execOnSmart:async()=>result}});
  const r=await ns.callTool('exec',{command:'false'});assert.equal(r.isError,true);assert.match(r.content[0].text,/FAILED/);
 }
});
test('17 MCP cancellation reaches AbortSignal; debug logs exclude passwords',async()=>{
 let seen;let release;const started=new Promise(r=>release=r);
 const {ns,output}=await load('mcp/server.mjs',{'../lib/engine.mjs':{getServer:()=>({name:'one',remote:'/home/testuser'}),execOnSmart:async(s,c,o)=>{seen=o.signal;release();return new Promise(r=>o.signal.addEventListener('abort',()=>r({done:false,exitCode:null})));}}},{env:{SRB_DEBUG:'1'}});
 const request=ns.handleMessage({id:42,method:'tools/call',params:{name:'exec',arguments:{command:'echo SECRET_FAKE'}}});await started;
 await ns.handleMessage({method:'notifications/cancelled',params:{requestId:42}});await request;
 assert.equal(seen.aborted,true);assert.doesNotMatch(output().stderr,/SECRET_FAKE/);
});
test('20 CLI preserves remote grep -f and tail -f flags',async()=>{
 let command;const mocked={getServer:()=>seed,execOnSmart:async(s,c)=>{command=c;return {output:'',exitCode:0};},closeAllPersist(){}};
 for(const tail of [['grep','-f','patterns','file'],['tail','-f','log']]){
  const {ns,proc}=await load('remote-shell.mjs',{'./lib/engine.mjs':mocked},{argv:[process.execPath,path.join(root,'remote-shell.mjs'),'exec','one',...tail]});
  await ns.main();assert.equal(proc.exitCode,0);assert.equal(command,tail.join(' '));
 }
});

test('CLI execution signals cancel the command and release all signal listeners',async()=>{
 let seen;const {ns,proc}=await load('remote-shell.mjs',{'./lib/engine.mjs':{getServer:()=>seed,execOnSmart:async(s,c,o)=>{seen=o.signal;queueMicrotask(()=>proc.emit('SIGTERM'));return new Promise(resolve=>o.signal.addEventListener('abort',()=>resolve({exitCode:null,aborted:true})));}}},{argv:[process.execPath,path.join(root,'remote-shell.mjs'),'exec','one','sleep 30']});
 await ns.main();assert.equal(seen.aborted,true);assert.equal(proc.exitCode,130);
 for(const signal of ['SIGINT','SIGTERM','SIGHUP'])assert.equal(proc.listenerCount(signal),0);
});

test('CLI rejects ignored legacy/unknown options before opening a connection',async()=>{
 const {ns}=await load('remote-shell.mjs',{'./lib/engine.mjs':{}},{argv:[process.execPath,path.join(root,'remote-shell.mjs'),'one','--timeout','20']});
 await assert.rejects(ns.main(),/usage:/);
});

test('CLI reexecutes the private Node without a shell, preserving arguments and exit status',async()=>{
 let called;
 const argv=['C:\\old\\node.exe',path.join(root,'remote-shell.mjs'),'exec','one','printf','argument with spaces','-f'];
 const mockedFs={...fs,default:fs,existsSync:()=>true,realpathSync:p=>p};
 await assert.rejects(load('remote-shell.mjs',{'./lib/engine.mjs':{ROOT:root},'node:fs':mockedFs,'node:child_process':{spawn:noProcess,spawnSync:(...args)=>{called=args;return {status:7};}}},{execPath:argv[0],argv,runEntry:true}),/EXIT 7/);
 assert.equal(called[0],root+'/runtime/node.exe');assert.deepEqual(Array.from(called[1]),argv.slice(1));
 assert.equal(called[2].stdio,'inherit');assert.equal(called[2].shell,undefined);
});
test('10 rclone requires host verification and unpredictable restricted config',async()=>{
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()},{env:{SRB_KNOWN_HOSTS:path.join(tmp,'absent')}});
 assert.throws(()=>ns.buildRcloneConf({name:'test',...seed}),/known_hosts/);
 assert.match(source('lib/engine.mjs'),/known_hosts_file/);assert.match(source('lib/engine.mjs'),/flag:'wx',mode:0o600/);
});
test('04 foreign drive is never deleted or overwritten; 18 probe is asynchronous',async()=>{
 save({one:{...seed,drive:'M:'}});const calls=[];
 const spawn=(exe,args)=>{calls.push([exe,args]);const p=child();queueMicrotask(()=>{p.stdout.emit('data',Buffer.from(JSON.stringify({exists:true,target:'\\\\foreign\\share'})));p.emit('close',0);});return p;};
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(),'node:child_process':{spawn,spawnSync:noProcess}});
 const r=await ns.mountServer(ns.getServer('one'));assert.equal(r.ok,false);assert.match(r.error,/occupied/);assert.equal(calls.length,1);assert.equal(calls[0][0],'powershell.exe');
});
test('03 diagnosis makes no unsupported process or owner claims',()=>{
 assert.doesNotMatch(source('lib/engine.mjs'),/tasklist|taskkill|runs as SYSTEM|Restart-Service/);
});

test('SSHFS selects explicit override, then private fixed runtime, then installed executable',async()=>{
 const fixed=path.join(root,'runtime','sshfs','bin','sshfs.exe');
 for(const available of [true,false]){
  const mockedFs={...fs,existsSync:p=>p===fixed?available:fs.existsSync(p)};
  const {ns}=await load('lib/engine.mjs',{'node:fs':mockedFs,'./persist.mjs':fakePersist()});
  assert.equal(ns.sshfsExecutable(),available?fixed:path.join('C:\\Program Files','SSHFS-Win','bin','sshfs.exe'));
 }
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()},{env:{SRB_SSHFS:'D:\\custom\\sshfs.exe'}});
 assert.equal(ns.sshfsExecutable(),'D:\\custom\\sshfs.exe');
});

test('SSHFS rejects old/unknown runtimes before SSH but accepts the upstream mkdir fix',async()=>{
 save({one:{...seed,drive:'Z:'}});
 for(const [version,status,accepted] of [['3.5.2',0,false],['3.7.1',0,false],['3.7.2',0,true],['3.8.0',0,true],['4.0.0',0,true],['unrecognized',0,false],['3.7.2',1,false]]){
  let remote=0;
  const spawn=(file,args)=>{const p=child();queueMicrotask(()=>{p.stdout.emit('data',Buffer.from(args[0]==='--version'?'SSHFS version '+version:JSON.stringify({exists:false,target:''})));p.emit('close',args[0]==='--version'?status:0);});return p;};
  const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(async()=>{remote++;throw new Error('past runtime gate');}),'node:child_process':{spawn,spawnSync:noProcess}},{env:{SRB_SSHFS:process.execPath}});
  const result=await ns.mountServer(ns.getServer('one'));
  assert.equal(result.ok,false);
  if(accepted){assert.equal(remote,1);assert.match(result.error,/past runtime gate/);}
  else{assert.equal(remote,0);assert.match(result.error,/SSHFS >= 3\.7\.2/);}
 }
});

test('SSHFS installer pins packages, bounds downloads and preserves existing runtimes',()=>{
 const entries=JSON.parse(source('tools/sshfs-runtime-lock.json'));
 assert.equal(entries.find(p=>p.name==='sshfs').archive,'x86_64/release/sshfs/sshfs-3.7.2-2.tar.xz');
 for(const entry of entries){assert.match(entry.sha512,/^[a-f0-9]{128}$/);assert.ok(Number.isSafeInteger(entry.size)&&entry.size>0);assert.ok(!entry.archive.includes('..'));}
 const installer=source('tools/install_sshfs_runtime.mjs');
 assert.match(installer,/size>pkg\.size/);assert.match(installer,/sha\(bytes\)!==pkg\.sha512/);
 assert.match(installer,/already exists; keep active mounts intact/);assert.doesNotMatch(installer,/rmSync|rmdirSync|net\.exe|mountServer/);
 assert.match(installer,/process\.argv\.includes\('--stage'\)/);
 assert.match(installer,/unexpected OpenSSH version/);
 assert.doesNotMatch(installer,/fs\.copyFileSync/);
});
test('06 local Bash verifies overwrite, append, decode failure and temporary cleanup',async t=>{
 const bash=process.platform==='win32'?'E:/Program Files/Git/bin/bash.exe':'/bin/bash';if(!fs.existsSync(bash))return t.skip('Bash unavailable');
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});const dest=path.join(tmp,'payload');
 const unix=p=>p.replace(/^([A-Z]):/i,(_,d)=>'/'+d.toLowerCase()).replaceAll('\\','/');const remote=unix(dest);
 const run=script=>spawnSync(bash,['--noprofile','--norc','-c',script],{encoding:'utf8',timeout:5000,windowsHide:true});
 fs.writeFileSync(dest,'ORIGINAL');const failed=run(ns.buildWriteCommand(remote,Buffer.from('REPLACED')).replace('UkVQTEFDRUQ=','!INVALID!'));
 assert.notEqual(failed.status,0);assert.equal(fs.readFileSync(dest,'utf8'),'ORIGINAL');
 const success=run(ns.buildWriteCommand(remote,Buffer.from('中文\n')));assert.equal(success.status,0,success.stderr);assert.equal(fs.readFileSync(dest,'utf8'),'中文\n');
 assert.equal(run(ns.buildWriteCommand(remote,Buffer.from('APPEND'),{append:true})).status,0);assert.equal(fs.readFileSync(dest,'utf8'),'中文\nAPPEND');
 assert.deepEqual(fs.readdirSync(tmp).filter(n=>n.startsWith('.srb-write')),[]);
});
test('remote controller blocks on events and retains bounded private task state',()=>{
 const loop=source('lib/exec-loop.sh');assert.match(loop,/umask 077/);assert.match(loop,/SRB_DIR/);assert.doesNotMatch(loop,/qout=|\/tmp\/\.srb-exec\.v4\./);
 const controller=source('lib/exec-loop.py');
 assert.match(controller,/LIMIT = 2 \* 1024 \* 1024/);assert.match(controller,/selector.select\(timeout\)/);assert.match(controller,/token == self.active.token/);assert.match(controller,/signal.SIGKILL/);
 assert.doesNotMatch(loop,/mkfifo|read -r -t 0.02/);assert.match(controller,/os.waitpid/);assert.match(controller,/task.deadline/);
});

test('MCP initialize advertises local files/light compute and remote heavy work without connecting',async()=>{
 const {ns,output}=await load('mcp/server.mjs',{'../lib/engine.mjs':{}});
 await ns.handleMessage({id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
 const result=JSON.parse(output().stdout).result;
 assert.equal(result.protocolVersion,'2025-06-18');
 assert.match(result.instructions,/Prefer host-native file search/);
 assert.match(result.instructions,/host-local tools for small-file parsing/);
 assert.match(result.instructions,/Run tests, builds, large data analysis, training/);
 assert.match(result.instructions,/After any write failure, inspect/);
 assert.match(result.instructions,/New mounts require SSHFS >=3\.7\.2/);
 assert.match(result.instructions,/requires remounting existing volumes/);
 assert.match(result.instructions,/Report raw host-tool errors/);
 await ns.handleMessage({id:2,method:'tools/list'});
 const listed=JSON.parse(output().stdout.trim().split('\n')[1]).result.tools;
 const exec=listed.find(t=>t.name==='exec');
 assert.equal(exec.inputSchema.properties.max_output_chars.default,8192);
 assert.match(listed.find(t=>t.name==='write_file').description,/SSH fallback/);
});

test('MCP discovery recommends verified link then drive, never an unavailable mount or unverified UNC',async()=>{
 for(const scenario of [
  {mount:'C:\\mapped',drive:'M:',status:{mount_ok:true,drive_mounted:true},expected:'C:\\mapped'},
  {mount:'C:\\broken-link',drive:'M:',status:{mount_ok:false,drive_mounted:true},expected:'M:\\'},
  {mount:null,drive:'M:',status:{mount_ok:false,drive_mounted:true},expected:'M:\\'},
  {mount:'C:\\mapped',drive:'M:',status:{mount_ok:false,drive_mounted:false},expected:null},
  {mount:null,drive:null,status:{mount_ok:false,drive_mounted:false},expected:null},
 ]) {
  const srv={name:'one',...seed,mount:scenario.mount,drive:scenario.drive};let probes=0;
  const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{
   configState:()=>({ok:true,file:config}),listServers:()=>[srv],getServer:()=>srv,
   serverMountStatus:async()=>{probes++;return scenario.status;},
   remoteToUnc:()=>String.raw`\\sshfs.r\testuser@example.invalid\home\testuser`,
   persistChannelStatus:()=>({alive:false}),
   getExecFor:()=>assert.fail('discovery must not establish SSH'),
  }});
  const list=JSON.parse((await ns.callTool('list_servers',{})).content[0].text);
  const status=JSON.parse((await ns.callTool('server_status',{server:'one'})).content[0].text);
  for(const view of [list.servers[0],status]) {
   assert.equal(view.file_access.local_root,scenario.expected);
   assert.equal(view.file_access.remote_root,seed.remote);
   assert.match(view.file_access.unc_root,/^\\\\sshfs\.r\\/);
   assert.equal(view.drive_mounted,scenario.status.drive_mounted);
   assert.equal(view.mount_ok,scenario.status.mount_ok);
  }
  assert.equal(probes,2);assert.doesNotMatch(JSON.stringify(list),/FAKE_ONLY/);
 }
});

test('MCP file fallback calls preserve SSH parameters without reprobing mappings',async()=>{
 const calls=[];const controller=new AbortController();
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{
  getServer:()=>seed,serverMountStatus:()=>assert.fail('do not refresh known mappings on every operation'),
  readFileRemoteSmart:async(...args)=>{calls.push(args);return {ok:true,size:2,isText:true,text:'OK'};},
  writeFileRemoteSmart:async(...args)=>{calls.push(args);return {ok:true,exitCode:0,bytes:2};},
 }});
 assert.equal((await ns.callTool('read_file',{path:'/outside/file',max_bytes:2},controller.signal)).isError,false);
 assert.equal((await ns.callTool('write_file',{path:'/outside/file',content:'OK',append:true},controller.signal)).isError,false);
 assert.equal(calls[0][1],'/outside/file');assert.equal(calls[0][2],2);assert.equal(calls[0][3].signal,controller.signal);
 assert.equal(calls[1][2],'OK');assert.equal(calls[1][3].append,true);assert.equal(calls[1][3].signal,controller.signal);
});

test('MCP exec defaults to 8192 body characters and preserves head and tail',async()=>{
 const output='HEAD'+'.'.repeat(12000)+'TAIL';let runs=0;
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{
  getServer:()=>({name:'one',remote:'/home/testuser'}),serverMountStatus:()=>assert.fail('exec must not probe the mount'),
  execOnSmart:async()=>{runs++;return {done:true,exitCode:0,output};},
 }});
 const result=await ns.callTool('exec',{command:'large-output'});const text=result.content[0].text;
 const body=text.slice(text.indexOf('\n')+1);
 assert.equal(result.isError,false);assert.match(text,/RESPONSE-LIMIT/);assert.doesNotMatch(text,/REMOTE-CAPTURE-LIMIT/);
 assert.equal(body.split('\n')[0],output.slice(0,4096));assert.equal(body.split('\n').at(-1),output.slice(-4096));
 const full=await ns.callTool('exec',{command:'large-output',max_output_chars:20000});
 assert.equal(full.content[0].text.split('\n').slice(1).join('\n'),output);assert.doesNotMatch(full.content[0].text,/RESPONSE-LIMIT/);
 assert.equal(runs,2);
});

test('MCP exec rejects invalid output limits before executing',async()=>{
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{
  getServer:()=>assert.fail('invalid arguments must not access the server'),
 }});
 for(const max_output_chars of [0,-1,1.5,2097153,'8192',null,true]) {
  const result=await ns.callTool('exec',{command:'never execute',max_output_chars});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/max_output_chars must be an integer/);
 }
});

test('MCP response trimming preserves Unicode code points, including a one-character budget',async()=>{
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{
  getServer:()=>({name:'one',remote:'/home/testuser'}),execOnSmart:async()=>({done:true,exitCode:0,output:'🙂甲乙丙丁🚀'}),
 }});
 for(const [limit,head,tail] of [[4,'🙂甲','丁🚀'],[3,'🙂甲','🚀'],[1,'🙂','']]) {
  const result=await ns.callTool('exec',{command:'unicode',max_output_chars:limit});
  const body=result.content[0].text.split('\n').slice(1).join('\n');
  assert.equal(body.split('\n')[0],head);assert.equal(body.split('\n').at(-1),tail);
  assert.ok(!body.isWellFormed || body.isWellFormed());
 }
 const exact=await ns.callTool('exec',{command:'unicode',max_output_chars:6});assert.doesNotMatch(exact.content[0].text,/RESPONSE-LIMIT/);
});

test('MCP response and remote capture limits keep failure, timeout and cancellation states distinct',async()=>{
 for(const failure of [
  {exitCode:7}, {exitCode:143,timedOut:true}, {exitCode:143,interrupted:true},
  {done:false,exitCode:null,spawnFailed:true}, {done:false,exitCode:null,aborted:true},
 ]) {
  const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{
   getServer:()=>({name:'one',remote:'/home/testuser'}),execOnSmart:async()=>({done:true,output:'a'.repeat(1000),truncated:true,...failure}),
  }});
  const result=await ns.callTool('exec',{command:'failed-job',max_output_chars:40});const text=result.content[0].text;
  assert.equal(result.isError,true);assert.match(text,/FAILED/);assert.match(text,/RESPONSE-LIMIT/);assert.match(text,/REMOTE-CAPTURE-LIMIT/);
  assert.ok(text.includes('exit='+failure.exitCode));
  if(failure.timedOut)assert.match(text,/TIMED-OUT/);
  if(failure.interrupted || failure.aborted)assert.match(text,/CANCELLED/);
  if(failure.spawnFailed)assert.match(text,/CHANNEL-FAILED/);
 }
});

test('file pages preserve UTF-8, exact EOF and explicit binary bytes',async()=>{
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});
 const page=(text,offset,max,format)=>ns.decodePage(Buffer.byteLength(text)+'\n'+Buffer.from(text).subarray(offset,offset+max+1).toString('base64'),offset,max,format);
 let r=page('中文🙂END',0,4);assert.equal(r.text,'中');assert.equal(r.next_offset,3);assert.equal(r.truncated,true);
 r=page('中文🙂END',3,7);assert.equal(r.text,'文🙂');assert.equal(r.next_offset,10);
 r=page('EXACT',0,5);assert.equal(r.truncated,false);
 assert.throws(()=>page('中',0,1),/too small/);assert.equal(page('中',0,1,'base64').base64,Buffer.from('中').subarray(0,1).toString('base64'));
 r=ns.decodePage('1\n/w==',0,1);assert.equal(r.isText,false);assert.equal(r.size,1);
 assert.throws(()=>ns.decodePage('4\n!!!!',0,4),/invalid/);
 const cut=Buffer.from('A中').subarray(0,3);r=ns.decodePage('3\n'+cut.toString('base64'),0,4,'auto',true);assert.equal(r.text,'A');assert.equal(r.next_offset,3);assert.equal(r.truncated,false);
});

test('MCP rejects content/append type coercions and omits binary by default',async()=>{
 let calls=0;
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{getServer:()=>seed,writeFileRemoteSmart:()=>{calls++;},readFileRemoteSmart:async()=>({ok:true,size:2,raw_size:2,total_size:2,offset:0,next_offset:2,isText:false,base64:'/wA='})}});
 for(const args of [{content:null},{content:4},{content:'x',append:'false'}]) {const r=await ns.callTool('write_file',{path:'/x',...args});assert.equal(r.isError,true);}
 assert.equal(calls,0);
 assert.doesNotMatch((await ns.callTool('read_file',{path:'/x'})).content[0].text,/\/wA=/);
 assert.match((await ns.callTool('read_file',{path:'/x',format:'base64'})).content[0].text,/\/wA=/);
});

test('engine rejects invalid write types and unsafe read ranges before SSH',async()=>{
 save({one:seed});const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(()=>assert.fail('no SSH'))});
 const srv=ns.getServer('one');
 for(const content of [null,{},1]) await assert.rejects(ns.writeFileRemoteSmart(srv,'/file',content),/content/);
 await assert.rejects(ns.writeFileRemoteSmart(srv,'/file','x',{append:'false'}),/append/);
 for(const offset of [-1,1.5,'0',Number.MAX_SAFE_INTEGER+1])await assert.rejects(ns.readFileRemoteSmart(srv,'/file',10,{offset}),/offset/);
});

test('MCP sends isolated cwd/output budget and renders compact retained result state',async()=>{
 let options;
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{getServer:()=>({name:'one',remote:'/home/test',host:'host-secret',user:'user-secret'}),execOnSmart:async(s,c,o)=>{options=o;return {done:true,exitCode:7,cwd:'/project',output:'🙂甲乙丙',outputTail:'丁戊🚀',resultId:'result123',duration:0.1};}}});
 const r=await ns.callTool('exec',{command:'work',cwd:'/project',max_output_chars:3});
 assert.equal(options.isolated,true);assert.equal(options.cwd,'/project');assert.equal(options.maxOutputChars,3);
 assert.equal(r.isError,true);assert.match(r.content[0].text,/cwd=\/project exit=7 FAILED/);assert.match(r.content[0].text,/result_id=[a-f0-9]{24}/);assert.doesNotMatch(r.content[0].text,/host-secret|user-secret|via=/);
 assert.match(r.content[0].text,/🙂甲\n/);assert.match(r.content[0].text,/\n🚀$/);
});

test('results are read by reference and expire without replaying commands',async()=>{
 save({one:seed});let executions=0,reads=0;
 const rex={alive:true,pending:new Map(),exec:async()=>{executions++;return {exitCode:7,output:'HEAD',outputTail:'TAIL',resultRef:{session:'/tmp/.srb-exec.TEST',token:'e1'},duration:0};},readResult:async()=>{reads++;return {exitCode:0,output:'8\nSEVBRA=='};}};
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':{...fakePersist(),getRemoteExec:()=>rex}});
 const r=await ns.execOnSmart(ns.getServer('one'),'SIDE EFFECT',{isolated:true});
 assert.ok(r.resultId);const p=await ns.readResult(r.resultId,0,4);assert.equal(p.text,'HEAD');assert.equal(p.exitCode,7);assert.equal(executions,1);assert.equal(reads,1);
 await assert.rejects(ns.readResult('unknown'),/expired/);assert.equal(executions,1);
});

test('retained protocol sends E budget and decodes head/tail without broken UTF-8',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});re.proc=child();let sent='';re.proc.stdin.write=s=>{sent=s;return true;};
 re._onLine('H - '+Buffer.from('/tmp/.srb-exec.TEST').toString('base64'));
 const r=re._execOne('hello',{retained:true,outputBudget:20});const t=re.curToken;assert.match(sent,/\|E e\d+ 20 /);
 re._onLine('O '+t+' '+Buffer.from('中文🙂').subarray(0,7).toString('base64'));re._onLine('Z '+t+' '+Buffer.from('甲🚀').subarray(1).toString('base64'));re._onLine('A '+t+' 100');re._onLine('D '+t+' 7');
 const out=await r;assert.equal(out.output,'中文');assert.equal(out.outputTail,'🚀');assert.equal(out.resultRef.session,re.session);assert.equal(out.exitCode,7);assert.equal(out.outputBytes,100);re.close();
});

test('queued cancellation resolves immediately and never interrupts another task',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});let release;re.chain=new Promise(r=>release=r);re.ensure=()=>assert.fail('cancelled task must not connect');
 const c=new AbortController();const r=re.exec('never',{signal:c.signal});c.abort();await assert.rejects(r,/cancelled/);release();await re.chain;
});

test('local process/config/mount/trust cancellation propagates and skips mutations',async()=>{
 const p=child();save({one:seed});
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(),'node:child_process':{spawn:()=>p,spawnSync:noProcess}});
 const c=new AbortController();const r=ns.runCaptureAsync('fake',[],{signal:c.signal});c.abort();await assert.rejects(r,/cancelled/);assert.equal(p.killed,true);
 const stopped=new AbortController();stopped.abort();const before=fs.readFileSync(config,'utf8');
 await assert.rejects(ns.saveServer({name:'one',note:'never'},{signal:stopped.signal}));
 await assert.rejects(ns.mountServer(ns.getServer('one'),{signal:stopped.signal}));
 await assert.rejects(ns.umountServer(ns.getServer('one'),{signal:stopped.signal}));
 await assert.rejects(ns.fetchHostKeyAsync('example.invalid',22,{signal:stopped.signal}));assert.equal(fs.readFileSync(config,'utf8'),before);
});

test('SSHFS known_hosts accepts only the configured SHA256 key',async()=>{
 const crypto=await import('node:crypto');const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});
 const key=Buffer.from('fake-public-key'),pin='SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
 const line='example.invalid ssh-ed25519 '+key.toString('base64');
 assert.equal(ns.pinnedKnownHosts('# comment\n'+line+'\nother ssh-rsa QUJD',pin),line+'\n');
 assert.throws(()=>ns.pinnedKnownHosts(line,'SHA256:WRONG'),/does not match/);
 assert.match(source('lib/engine.mjs'),/StrictHostKeyChecking=yes/);assert.doesNotMatch(source('lib/engine.mjs'),/StrictHostKeyChecking=no/);
});

test('readline completer returns [matches, completeOn], keeping preceding command',async()=>{
 const {ns}=await load('lib/complete.mjs',{'./engine.mjs':{getExecFor:()=>({query:async()=>({output:'src/\nfile name\n'})})}});
 const call=(line,hooks={})=>new Promise((resolve,reject)=>ns.makeCompleter(seed,hooks)(line,(e,r)=>e?reject(e):resolve(r)));
 let r=await call('cat sr');assert.equal(r[1],'cat sr');assert.ok(r[0].includes('cat src/'));
 r=await call('cat fi');assert.ok(r[0].includes("cat 'file name'"));
 r=await call('cat sr',{isBusy:()=>true});assert.equal(r[0].length,0);assert.equal(r[1],'cat sr');
 const {PassThrough}=await import('node:stream'),readline=await import('node:readline');
 const input=new PassThrough(),output=new PassThrough();output.on('data',()=>{});
 const rl=readline.createInterface({input,output,terminal:true,completer:ns.makeCompleter(seed)});
 try {rl.write('exit');assert.doesNotThrow(()=>rl.write(null,{name:'tab'}));await new Promise(r=>setImmediate(r));assert.equal(rl.line,'exit');}
 finally {rl.close();input.end();output.end();}
});

test('Codex registration handles first header, multiline args, env and repeated runs',async()=>{
 const {ns}=await load('tools/register_mcp_codex.mjs',{}, {argv:[process.execPath,'test-runner.mjs'],env:{SRB_CODEX_CONFIG_DIR:path.join(tmp,'codex')}});
 const text='[mcp_servers.ssh-remote-bridge]\ncommand = "old"\nargs = [\n "old",\n]\nenabled = true\n[mcp_servers.ssh-remote-bridge.env]\nFAKE = "keep"\n[other]\nvalue = 1\n';
 const r=ns.updateToml(text,"C:/it's/node.exe",'C:/bridge/server.mjs');assert.equal((r.match(/\[mcp_servers.ssh-remote-bridge\]/g)||[]).length,1);assert.match(r,/FAKE = "keep"/);assert.match(r,/enabled = true/);assert.match(r,/value = 1/);assert.doesNotMatch(r,/"old"/);
 assert.equal(ns.updateToml(r,"C:/it's/node.exe",'C:/bridge/server.mjs'),r);
 assert.throws(()=>ns.updateToml(text+'[mcp_servers.ssh-remote-bridge]\n','node','server'),/duplicate/);
 const multi='description = """\n[mcp_servers.ssh-remote-bridge]\n"""\n';assert.match(ns.updateToml(multi,'node','server'),/command = "node"/);
});

test('Windows entrypoints use system Node and pass paths through environment data',()=>{
 assert.match(source('register_mcp_codex.cmd'),/where \/q node/);assert.match(source('register_mcp_codex.cmd'),/DisableDelayedExpansion/);
 const cmd=source('open-ssh-remote-terminal.cmd');assert.match(cmd,/\$env:TARGET/);assert.doesNotMatch(cmd,/'%TARGET%'|'%NODE%'/);
 assert.match(source('tools/default_mount.mjs'),/srv.drive/);
});

test('empty WinFsp root probe uses bounded metadata fallback and closes its directory handle',async()=>{
 let script;const spawn=(exe,args)=>{script=args[args.indexOf('-e')+1];const p=child();queueMicrotask(()=>p.emit('close',0));return p;};
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist(),'node:child_process':{spawn,spawnSync:noProcess}});
 assert.equal(await ns.mountOk('Z:\\'),true);let closed=0,accessed=0;
 const code=script.replace('import fs from "node:fs";','');
 const fake={constants:{R_OK:4},opendirSync:()=>({readSync(){throw Object.assign(new Error('empty root'),{code:'EINVAL'});},closeSync(){closed++;}}),accessSync(){accessed++;},statSync:()=>({isDirectory:()=>true})};
 vm.runInNewContext(code,{fs:fake,process:{argv:['node','Z:\\']}});assert.equal(closed,1);assert.equal(accessed,1);
 fake.statSync=()=>({isDirectory:()=>false});assert.throws(()=>vm.runInNewContext(code,{fs:fake,process:{argv:['node','Z:\\']}}),/empty root/);assert.equal(closed,2);
});

test('stream retention never adds a replacement character at the byte cap',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});re.proc=child();
 const p=re._execOne('large unicode',{stream:true});const t=re.curToken,bytes=Buffer.from('中'.repeat(710000));
 for(let offset=0;offset<bytes.length;offset+=32768)re._onLine('S '+t+' '+bytes.subarray(offset,offset+32768).toString('base64'));
 re._onLine('D '+t+' 0');const r=await p;assert.equal(r.truncated,true);assert.ok(Buffer.byteLength(r.output)<=ns.MAX_OUTPUT);assert.ok(!r.output.includes('\ufffd'));re.close();
});

test('quoted TOML keys retain env and inline/unfinished TOML fails without a rewrite',async()=>{
 const {ns}=await load('tools/register_mcp_codex.mjs',{}, {argv:[process.execPath,'test-runner.mjs']});
 const r=ns.updateToml('["mcp_servers"."ssh-remote-bridge"]#comment\n"command" = "old"\n\'args\' = ["old"]\nenv = { KEEP = "yes" }\n','node','server');
 assert.equal((r.match(/command = /g)||[]).length,1);assert.match(r,/KEEP = "yes"/);assert.doesNotMatch(r,/"old"/);
 assert.throws(()=>ns.updateToml('mcp_servers = { ssh-remote-bridge = {} }','node','server'),/inline/);
 assert.throws(()=>ns.updateToml('[mcp_servers.ssh-remote-bridge]\nargs = ["unfinished"','node','server'),/unfinished/);
});

test('read_result retains original failure/timeout/cancel flags and does not execute',async()=>{
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{readResult:async()=>({server:'one',exitCode:143,timedOut:true,interrupted:true,size:3,total_size:3,offset:0,next_offset:3,isText:true,text:'ERR'}),execOnSmart:()=>assert.fail('result lookup must not execute')}});
 const r=await ns.callTool('read_result',{result_id:'id'});assert.equal(r.isError,true);assert.match(r.content[0].text,/exit=143 FAILED TIMED-OUT CANCELLED/);assert.match(r.content[0].text,/\nERR$/);
});

test('Windows CRLF checkout is normalized before bootstrapping Linux Bash',async()=>{
 let remote;const spawn=(exe,args)=>{remote=args.at(-1);const p=child();p.stdin.write=line=>{const m=/\|C (w\d+)/.exec(line);if(m)queueMicrotask(()=>p.stdout.emit('data',Buffer.from('D '+m[1]+' 0\n')));return true;};return p;};
 const {ns}=await load('lib/persist.mjs',{'node:child_process':{spawn,spawnSync:noProcess},'node:fs':{readFileSync:p=>source('lib/'+path.basename(p)).replaceAll('\n','\r\n')}});
 const re=new ns.RemoteExec('x',{hostkey:'SHA256:FAKE'});await re.ensure();const script=Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(remote)[1],'base64').toString('utf8');assert.ok(script.includes('class Controller:'));assert.ok(!script.includes('__SRB_CONTROLLER__'));assert.ok(!script.includes('\r'));re.close();
});

test('WorkBuddy registration preserves env/options and refuses corrupt config intact',async()=>{
 const home=path.join(tmp,'workbuddy-home'),dir=path.join(home,'.workbuddy'),file=path.join(dir,'mcp.json');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(file,JSON.stringify({mcpServers:{other:{command:'other'},'ssh-remote-bridge':{command:'old',args:['old'],env:{FAKE:'keep'},enabled:true}}}));
 const mocks={'node:os':{homedir:()=>home}},options={console:{log(){},warn(){},error(){}}};
 await load('tools/register_mcp.mjs',mocks,options);const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(cfg.mcpServers['ssh-remote-bridge'].env.FAKE,'keep');assert.equal(cfg.mcpServers['ssh-remote-bridge'].enabled,true);assert.equal(cfg.mcpServers.other.command,'other');
 fs.writeFileSync(file,'{broken');await assert.rejects(load('tools/register_mcp.mjs',mocks,options),/invalid/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});

test('native terminal pins the host key and rejects missing fingerprints',async()=>{
 const crypto=await import('node:crypto'),{ns}=await load('lib/terminal.mjs');const key=Buffer.from('test-public-key');
 const cfg=ns.terminalConfig({...seed,hostkey:'SHA256:'+crypto.createHash('sha256').update(key).digest('base64')});
 assert.equal(cfg.hostVerifier(key),true);assert.equal(cfg.hostVerifier(Buffer.from('other key')),false);assert.equal(cfg.password,'FAKE_ONLY');
 assert.throws(()=>ns.terminalConfig({...seed,hostkey:null}),/pinned/);
});

test('native terminal forwards Tab/Ctrl+C/ANSI, resizes the PTY and restores raw mode',async()=>{
 const stream=new EventEmitter();stream.stderr=new EventEmitter();let written=[],sizes=[],client,output='';
 stream.write=b=>{written.push(Buffer.from(b));return true;};stream.pause=()=>{};stream.resume=()=>{};stream.setWindow=(...a)=>sizes.push(a);stream.close=()=>{};
 class Client extends EventEmitter {constructor(){super();client=this;}connect(c){this.config=c;queueMicrotask(()=>this.emit('ready'));}exec(cmd,opts,cb){this.command=cmd;this.options=opts;cb(null,stream);}destroy(){this.destroyed=true;}}
 const {ns,proc}=await load('lib/terminal.mjs',{'ssh2':{default:{Client,utils:{}}}});
 const input=new EventEmitter();input.isTTY=true;input.isRaw=false;input.pause=()=>{};input.resume=()=>{};input.setRawMode=v=>input.isRaw=v;
 const out=new EventEmitter();out.isTTY=true;out.rows=30;out.columns=100;out.write=b=>{output+=b;return true;};proc.stdin=input;proc.stdout=out;
 const p=ns.runPtyTerminal({...seed,hostkey:'SHA256:'+Buffer.alloc(32).toString('base64')},{cwd:"/tmp/it's a project"});await new Promise(r=>setImmediate(r));
 assert.equal(input.isRaw,true);assert.equal(client.options.pty.term,'xterm-256color');assert.match(client.command,/exec bash -il$/);
 input.emit('data',Buffer.from('ls\t\x03'));assert.equal(written[0].toString(),'ls\t\x03');
 stream.emit('data',Buffer.from('\x1b[31mRED\x1b[0m'));assert.ok(output.includes('\x1b[31mRED\x1b[0m'));
 out.rows=40;out.columns=120;out.emit('resize');assert.deepEqual(sizes,[[40,120,0,0]]);
 stream.emit('exit',0);stream.emit('close');assert.equal(await p,0);assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);assert.equal(out.listenerCount('resize'),0);assert.equal(client.destroyed,true);
});

test('TTY CLI uses native PTY and gpu watch keeps original colours',async()=>{
 for(const argv of [['one'],['gpu','-w','one']]) {
  let seen;const {ns,proc}=await load('remote-shell.mjs',{'./lib/engine.mjs':{getServer:()=>({...seed,name:'one'}),localToRemote:()=>'/project'},'./lib/terminal.mjs':{runPtyTerminal:async(...args)=>{seen=args;return 0;}}},{argv:[process.execPath,path.join(root,'remote-shell.mjs'),...argv]});
  proc.stdin={isTTY:true};proc.stdout.isTTY=true;await ns.main();assert.equal(seen[1].cwd,'/project');assert.equal(proc.exitCode,0);
  if(argv[0]==='gpu')assert.equal(seen[1].command,'gpustat -i 2');
 }
});

test('active result range queries bypass command queue without replacing its token',async()=>{
 const {ns}=await load('lib/persist.mjs');const re=new ns.RemoteExec('x',{});re.proc=child();re.ready=true;re.session='/tmp/.srb-exec.TEST';const sent=[];re.proc.stdin.write=s=>{sent.push(s);return true;};
 const command=re._execOne('sleep',{retained:true,live:true});const t=re.curToken;assert.match(sent[0],/\|J e\d+/);
 const reading=re.readResult(re.session,t,0,10),query=[...re.pending.keys()].find(k=>k.startsWith('r'));assert.ok(query);assert.equal(re.curToken,t);assert.match(sent.at(-1),/^B r\d+ e\d+ 0 10/);
 re._onLine('O '+query+' '+Buffer.from('3\nYWJj').toString('base64'));re._onLine('D '+query+' 0');assert.equal((await reading).output,'3\nYWJj');assert.ok(re.pending.has(t));assert.equal(re.curToken,t);
 const c=new AbortController(),cancel=re.readResult(re.session,t,0,10,{signal:c.signal});c.abort();await assert.rejects(cancel,/unchanged/);assert.ok(!sent.some(s=>s.startsWith('X')));
 re._onLine('D '+t+' 0');await command;re.close();
});

test('live file snapshots hold incomplete UTF-8 bytes until the next page',async()=>{
 const {ns}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});
 let p=ns.decodePage('1\n'+Buffer.from('中').subarray(0,1).toString('base64'),0,8192,'auto',false,true);assert.equal(p.text,'');assert.equal(p.next_offset,0);assert.equal(p.isText,true);
 p=ns.decodePage('3\n'+Buffer.from('中').toString('base64'),0,8192,'auto',false,true);assert.equal(p.text,'中');assert.equal(p.next_offset,3);
});

test('jobs return incremental output before completion and never rerun commands',async()=>{
 const {ns:engine}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()}),{ns}=await load('lib/jobs.mjs');let options,release,runs=0,data=Buffer.alloc(0);
 const jobs=new ns.ExecJobs({decodePage:engine.decodePage,execOnSmart:async(s,c,o)=>{runs++;options=o;o.onStart({read:async(offset,max)=>({exitCode:0,output:data.length+'\n'+data.subarray(offset,offset+max+1).toString('base64')})});return new Promise(r=>release=r);}});
 const j=jobs.start({...seed,name:'one'},'run once',{cwd:'/project'});await new Promise(r=>setImmediate(r));
 const page=jobs.page(j.id,0,8192,{waitMs:1000});setTimeout(()=>{data=Buffer.from('FIRST中');options.onOutput(data.length,false);},10);
 const p=await page;assert.equal(p.text,'FIRST中');assert.equal(p.state,'running');assert.equal(j.result,null);assert.equal(runs,1);
 data=Buffer.from('FIRST中LAST');release({done:true,exitCode:7,cwd:'/project',outputBytes:data.length});await j.promise;
 const last=await jobs.page(j.id,p.next_offset,8192);assert.equal(last.text,'LAST');assert.equal(last.exitCode,7);assert.equal(last.state,'completed');assert.equal(runs,1);
 j.finished=Date.now()-600001;assert.equal(jobs.has(j.id),false);
});

test('cancelling a read wait keeps the job alive; cancel_exec targets the job controller',async()=>{
 const {ns:engine}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()}),{ns}=await load('lib/jobs.mjs');
 const jobs=new ns.ExecJobs({decodePage:engine.decodePage,execOnSmart:async(s,c,o)=>new Promise(resolve=>{o.onStart({read:async()=>({exitCode:0,output:'0\n'})});o.signal.addEventListener('abort',()=>resolve({done:true,exitCode:143,interrupted:true}));})});
 const j=jobs.start({...seed,name:'one'},'sleep',{cwd:'/project'});await new Promise(r=>setImmediate(r));const c=new AbortController();const read=jobs.page(j.id,0,10,{waitMs:1000,signal:c.signal});setTimeout(()=>c.abort(),10);await assert.rejects(read,/unchanged/);assert.equal(j.controller.signal.aborted,false);
 jobs.cancel(j.id);assert.equal(j.state,'cancelling');await j.promise;assert.equal(j.result.interrupted,true);jobs.close();
});

test('active jobs are bounded and never evicted by expiry or a new request',async()=>{
 const {ns}=await load('lib/jobs.mjs');const jobs=new ns.ExecJobs({execOnSmart:async(s,c,o)=>o.signal.aborted?{exitCode:143}:new Promise(resolve=>o.signal.addEventListener('abort',()=>resolve({exitCode:143})))});
 const active=Array.from({length:16},()=>jobs.start({...seed,name:'one'},'wait',{cwd:'/project'}));active[0].created=Date.now()-1000000;assert.equal(jobs.has(active[0].id),true);
 assert.throws(()=>jobs.start({...seed,name:'one'},'never',{cwd:'/project'}),/too many active/);jobs.close();await Promise.all(active.map(j=>j.promise));
});

test('exec and read_result validate wait budgets before starting commands',async()=>{
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{getServer:()=>assert.fail('invalid waits must not start work')}});
 for(const value of [-1,30001,0.5,'1000',null]) {
  assert.equal((await ns.callTool('exec',{command:'never',yield_time_ms:value})).isError,true);
  assert.equal((await ns.callTool('read_result',{result_id:'never',wait_ms:value})).isError,true);
 }
});

test('a failure completing between yield and first page is never reported as success',async()=>{
 const {ns:engine}=await load('lib/engine.mjs',{'./persist.mjs':fakePersist()});let release;
 const {ns}=await load('mcp/server.mjs',{'../lib/engine.mjs':{getServer:()=>({...seed,name:'one'}),decodePage:engine.decodePage,execOnSmart:async(s,c,o)=>{
  o.onStart({read:async()=>{release({done:true,exitCode:7,output:'FAILED OUTPUT',cwd:'/project'});await new Promise(r=>setImmediate(r));return {exitCode:0,output:'4\nRkFJTA=='};}});
  return new Promise(r=>release=r);
 }}});
 const r=await ns.callTool('exec',{command:'fail at yield',yield_time_ms:0});assert.equal(r.isError,true);assert.match(r.content[0].text,/exit=7 FAILED/);assert.match(r.content[0].text,/FAILED OUTPUT/);
});
