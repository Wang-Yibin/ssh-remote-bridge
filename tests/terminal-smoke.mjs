import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {terminalConfig} from '../lib/terminal.mjs';
import {getServer} from '../lib/engine.mjs';
const require=createRequire(import.meta.url),{Client}=require('ssh2'),srv=getServer(process.argv[2]),client=new Client();
await new Promise((resolve,reject)=>{client.once('ready',resolve);client.once('error',reject);client.connect(terminalConfig(srv));});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const exec=(script,pty)=>new Promise((resolve,reject)=>client.exec(script,{pty},(error,ch)=>{if(error)return reject(error);let text='';ch.on('data',b=>text+=b);ch.on('error',reject);ch.on('close',(code)=>resolve({text,code}));if(pty)ch.setWindow(40,120,0,0);}));
try {
 let r=await exec('bash -ilc '+quote('sleep .2; test -t 0 && test -t 1 && printf "TTY_OK\\033[31mRED\\033[0m\\n"; stty size; type _init_completion >/dev/null 2>&1 && echo COMPLETION_LOADED || true'),{term:'xterm-256color',rows:24,cols:80});
 assert.ok(r.text.includes('TTY_OK'));assert.ok(r.text.includes('\x1b[31mRED\x1b[0m'));assert.ok(r.text.includes('40 120'));console.log('PASS SSH2 pinned PTY, ANSI colour and remote window resize; programmable completion loaded='+r.text.includes('COMPLETION_LOADED'));
 const tab=await new Promise((resolve,reject)=>{
  const script="D=$(mktemp -d /tmp/srb-pty-check.XXXXXXXXXX) || exit; trap 'rm -rf -- \"$D\"' EXIT; touch \"$D/unique_completion_file\"; cd \"$D\"; export HISTFILE=/dev/null; export PS1='__PTY_PROMPT__ '; bash --noprofile --norc -i";
  client.exec(script,{pty:{term:'xterm-256color',rows:30,cols:100}},(error,ch)=>{if(error)return reject(error);let text='',stage=0;const timer=setTimeout(()=>{ch.close();reject(Error('Tab PTY check timed out'));},8000);
   ch.on('data',b=>{text+=b;if(stage===0&&text.includes('__PTY_PROMPT__ ')){stage=1;ch.write("printf '__TAB__%s\\n' uni\t\n");}else if(stage===1&&text.includes('__TAB__unique_completion_file')){stage=2;ch.write('sleep 30\n');setTimeout(()=>ch.write('\x03'),200);}else if(stage===2&&text.includes('^C')){stage=3;ch.write("printf '__CTRL_C_OK__\\n'; exit\n");}});ch.on('error',reject);ch.on('close',()=>{clearTimeout(timer);resolve(text);});
  });
 });assert.ok(tab.includes('__TAB__unique_completion_file'));assert.ok(tab.includes('__CTRL_C_OK__\r\n'));console.log('PASS real Tab completion and Ctrl+C foreground interruption');
 for(const command of ['htop','nvitop','gpustat -i 1']) {
  const probe=await exec('bash -ilc '+quote('if command -v '+command.split(' ')[0]+' >/dev/null; then timeout -s INT -k 2 2 '+command+'; else echo NOT_INSTALLED; fi'),{term:'xterm-256color',rows:30,cols:100});
  console.log(command+': '+(probe.text.includes('NOT_INSTALLED')?'not installed':('PTY output='+probe.text.length+' chars, ANSI='+/\x1b\[/.test(probe.text))));
 }
} finally {client.end();}
