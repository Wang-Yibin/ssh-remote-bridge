import ssh2 from 'ssh2';
import fs from 'node:fs';
import crypto from 'node:crypto';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function terminalConfig(srv) {
  const pin=String(srv.hostkey||'').match(/SHA256:([A-Za-z0-9+/]+={0,2})/)?.[1];
  const expected=Buffer.from(pin||'','base64');
  if(expected.length!==32) throw new Error('terminal requires a pinned SHA256 host key');
  const config={host:srv.host,port:srv.port||22,username:srv.user,readyTimeout:90000,keepaliveInterval:30000,keepaliveCountMax:3,
    hostVerifier:key=>crypto.timingSafeEqual(crypto.createHash('sha256').update(key).digest(),expected)};
  if(srv.keyFile) {
    config.privateKey=fs.readFileSync(srv.keyFile);
    const parsed=ssh2.utils.parseKey(config.privateKey);
    if(parsed instanceof Error) throw new Error('cannot load terminal private key: '+parsed.message);
  } else if(typeof srv.password==='string') {config.password=srv.password;config.tryKeyboard=true;}
  else throw new Error('terminal authentication is missing');
  return config;
}

// One remote PTY owns input, completion, screen updates and window size for the whole session.
export async function runPtyTerminal(srv,{cwd=srv.remote,command}={}) {
  if(!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive PTY requires a real terminal; use ssh-remote exec for pipes');
  if(typeof cwd!=='string' || !cwd.startsWith('/') || /[\0\r\n]/.test(cwd)) throw new Error('invalid terminal cwd');
  const config=terminalConfig(srv),client=new ssh2.Client();
  return new Promise((resolve,reject)=>{
    let channel,finished=false,code=null,wasRaw=!!process.stdin.isRaw,raw=false;
    const size=()=>({term:'xterm-256color',cols:process.stdout.columns||80,rows:process.stdout.rows||24});
    const input=data=>{if(channel && !channel.write(data))process.stdin.pause();};
    const eof=()=>channel?.end();
    const resize=()=>{if(channel){try{const s=size();channel.setWindow(s.rows,s.cols,0,0);}catch(error){finish(error);}}};
    const interrupt=()=>{if(channel)channel.write('\x03');else finish(null,130);};
    const output=data=>{if(!process.stdout.write(data))channel?.pause();};
    const errorOutput=data=>{if(!process.stderr.write(data))channel?.stderr.pause();};
    const drain=()=>channel?.resume();
    const errorDrain=()=>channel?.stderr.resume();
    const terminate=()=>finish(null,143);
    function finish(error,status=code) {
      if(finished)return;finished=true;
      process.stdin.removeListener('data',input);process.stdin.removeListener('end',eof);
      process.stdout.removeListener('resize',resize);process.stdout.removeListener('drain',drain);process.removeListener('SIGINT',interrupt);
      process.stderr.removeListener('drain',errorDrain);process.removeListener('SIGTERM',terminate);process.removeListener('SIGHUP',terminate);
      process.stdin.pause();
      try {if(raw)process.stdin.setRawMode(wasRaw);} catch {}
      if(raw)process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
      client.destroy();
      if(error)reject(error);else resolve(Number.isInteger(status)?status:1);
    }
    process.on('SIGINT',interrupt);
    process.on('SIGTERM',terminate);process.on('SIGHUP',terminate);
    client.on('error',error=>finish(error));
    client.on('close',()=>finish(null));
    client.on('keyboard-interactive',(_name,_instruction,_language,prompts,answer)=>answer(prompts.length===1 && !prompts[0].echo && /password|密码|口令/i.test(prompts[0].prompt) ? [srv.password] : []));
    client.on('ready',()=>{
      if(finished)return;
      const script='cd -- '+quote(cwd)+' || exit\nexec bash -il'+(command===undefined?'':'c '+quote(command));
      client.exec(script,{pty:size()},(error,stream)=>{
        if(finished){stream?.close();return;}
        if(error){finish(error);return;}
        channel=stream;
        stream.on('error',error=>finish(error));
        stream.on('exit',(status,signal)=>{code=Number.isInteger(status)?status:signal==='INT'?130:signal==='TERM'?143:null;});
        stream.on('close',()=>finish(null));
        stream.on('data',output);stream.stderr.on('data',errorOutput);process.stderr.on('drain',errorDrain);
        stream.on('drain',()=>{if(!finished)process.stdin.resume();});
        process.stdout.on('drain',drain);process.stdout.on('resize',resize);
        try {
          process.stdin.setRawMode(true);raw=true;
          process.stdin.on('data',input);process.stdin.once('end',eof);process.stdin.resume();
        } catch(error){finish(error);}
      });
    });
    try {client.connect(config);} catch(error){finish(error);}
  });
}
