#!/usr/bin/env node
/**
 * remote-shell.mjs — ssh-remote CLI (多服务器)
 *
 * 用法:
 *   ssh-remote                      交互 shell (默认服务器)
 *   ssh-remote <profile>            交互 shell (指定服务器, 如 ssh-remote 5090)
 *   ssh-remote list                 列出所有服务器及挂载状态
 *   ssh-remote setup [profile]      挂载: 校验主机指纹的后台 SSHFS + 可选目录链接
 *   ssh-remote umount [profile]     卸载盘符映射
 *   ssh-remote exec <profile> <cmd...>   单条命令执行后退出
 *   ssh-remote rclone [profile]    备用挂载: rclone 挂到盘符 (SSHFS-Win 路线失败时用)
 *   ssh-remote help                 帮助
 *
 * 交互 shell 内:
 *   exit | quit | Ctrl+D  退出（断开长连接）
 *   Ctrl+C                中断正在运行的远程命令（不退出）; 空闲时清空输入行
 *   raw <cmd>             全屏交互模式 (plink -t 直连), 适用于 vim/htop/top/watch
 *   ! <cmd>               同 raw
 *   help | ?              帮助
 *   其余命令              经长连接送到服务器执行（cd/export 状态跨命令保持）
 */
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import * as engine from './lib/engine.mjs';
import { makeCompleter, resetCompletionCache } from './lib/complete.mjs';
import { runPtyTerminal } from './lib/terminal.mjs';

// ANSI 控制码。控制台默认 GBK, 输出 UTF-8 前先切到 UTF-8 才不会出现乱码
const CLR = '[H[2J'; // 清屏 + 光标归位
const HIDE_CURSOR = '[?25l';
const SHOW_CURSOR = '[?25h';

/** 持续刷新的命令: 这些天然输出纯文本循环, 不需要 PTY, 直接流式回传 */
/** 这类命令在长连接上跑不起来（要 PTY / 键盘输入), 提示走 raw */
function needsRawHint(line) {
  const first = (line.trim().split(/\s+/)[0] || '').toLowerCase();
  if (!first) return null;
  if (first === 'clear') return null; // clear 在本地没意义
  const base = first.split('/').pop();
  if (['htop', 'top', 'nvtop', 'nvitop', 'btop', 'vim', 'vi', 'nano', 'emacs', 'man', 'less', 'tmux', 'screen', 'fzf', 'lazygit'].includes(base)) {
    return base;
  }
  return null;
}

/**
 * 判断是否「持续刷新」类命令 —— 这些命令永远不自己结束, 不流式就只能干等。
 * 只认明确会循环的命令, 不做前缀猜测 (比如 "ls" 不是, "ls -f" 也不是)。
 */
function isLiveRefresh(line) {
  const t = line.trim();
  if (!t) return false;
  // gpustat -i / -i 2 / -w ; nvidia-smi -l 2 ; tail -f ; ping host
  const first = t.split(/\s+/)[0].split('/').pop().toLowerCase();
  if (first === 'ping' || first === 'tail' || first === 'journalctl' || first === 'docker' || first === 'kubectl') {
    // 这些默认就是持续输出 (tail 不带 -f 是一次性的, 但流式也无害)
    return true;
  }
  if (first === 'gpustat') return /(^|\s)(-\w*\s*)*(-i|--interval|--watch|-w)(\s|=|$)/.test(t);
  if (first === 'nvidia-smi') return /(^|\s)-l(\s|=|$)/.test(t);
  if (first === 'watch') return true;
  return false;
}

/**
 * 这类命令自己会清屏/原地刷新 (输出里没有 ANSI 码, 会无限追加),
 * 所以本地每批到达要先清一次屏, 否则几秒就刷出几千行。
 */
function isSelfClearing(line) {
  const t = line.trim();
  if (!t) return false;
  const first = t.split(/\s+/)[0].split('/').pop().toLowerCase();
  if (first === 'gpustat') return /(^|\s)(-\w*\s*)*(-i|--interval|--watch|-w)(\s|=|$)/.test(t);
  return false;
}

function printHelp(srv) {
  console.log([
    'ssh-remote [profile]                 native Linux PTY shell (real terminal required)',
    '  Tab: remote Bash completion; Ctrl+C: interrupt; exit/Ctrl+D: leave',
    '  htop / nvitop / gpustat -i: native screen refresh, colours and keyboard',
    'ssh-remote [profile] --framed        legacy line-based shell (also used for pipes)',
    'ssh-remote exec [-f] <profile> <cmd> run a script; -f prints live output',
    'ssh-remote gpu [-w] [profile]        GPU snapshot / live PTY view',
    'ssh-remote list | setup | umount | rclone [profile]',
    'ssh-remote help',
    '',
    'Profile credentials and pinned host keys come from servers.json.',
    'Run npm ci for a source checkout; native PTY uses ssh2.',
    'config: '+engine.CONFIG_PATH,
  ].join('\n'));
}

async function cancellable(operation) {
  const controller=new AbortController(),abort=()=>controller.abort();
  const signals=['SIGINT','SIGTERM','SIGHUP'];
  for(const signal of signals)process.on(signal,abort);
  try {return await operation(controller.signal);}
  finally {for(const signal of signals)process.removeListener(signal,abort);}
}

async function printServerList(signal) {
  const servers = engine.listServers();
  console.log('configured servers:');
  for (const s of servers) {
    const status = await engine.serverMountStatus(s,{signal});
    const dm = status.drive_mounted ? 'mounted' : 'NOT mounted';
    const mo = status.mount_ok ? 'ok' : 'no';
    console.log(
      `  ${s.name.padEnd(12)} ${s.user}@${s.host}:${s.port}  drive=${String(s.drive).padEnd(4)} ${dm}  mount=${s.mount || '-'} ${mo}${s.default ? '  [default]' : ''}`
    );
    if (s.note) console.log(`               note: ${s.note}`);
  }
}

async function doSetup(profile) {
  const srv = engine.getServer(profile);
  const local=srv.mount||srv.drive+'\\';
  console.log(`[ssh-remote] mounting ${srv.name}: ${srv.user}@${srv.host}:${srv.remote} -> ${local} (drive ${srv.drive})`);
  const r = await cancellable(signal=>engine.mountServer(srv,{signal}));
  r.steps.forEach((s) => console.log('  ' + s));
  if (!r.ok) {
    throw new Error(`mount FAILED: ${r.error}`);
  }
  if (r.warning) console.log(`[ssh-remote] WARNING: ${r.warning}`);
  console.log(`[ssh-remote] done. ${local} is now the server's ${srv.remote}`);
}

async function doUmount(profile) {
  const srv = engine.getServer(profile);
  console.log(`[ssh-remote] unmounting ${srv.name} (drive ${srv.drive})`);
  const r = await cancellable(signal=>engine.umountServer(srv,{signal}));
  r.steps.forEach((s) => console.log('  ' + s));
  if (!r.ok) throw new Error(r.error);
  // mount 可能没配（只用盘符模式）——措辞要跟着变, 别打印 "symlink null"
  const tail = srv.mount
    ? `symlink ${srv.mount} kept; run "ssh-remote setup ${srv.name}" to restore.`
    : `run "ssh-remote setup ${srv.name}" (or remount_all.cmd) to restore the drive.`;
  console.log(`[ssh-remote] done. ${tail}`);
}

async function doExec(profile, cmd, follow) {
  const srv = engine.getServer(profile);
  if (follow) {
    return doStream(srv, cmd);
  }
  const r=await cancellable(signal=>engine.execOnSmart(srv,cmd,{timeout:300,signal}));
  if (r.output && r.output.trim()) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n');
  if (r.spawnFailed) {
    console.error(`[ssh-remote] channel error: ${r.error}`);
    process.exitCode=2;return;
  }
  process.exitCode=r.timedOut?124:r.interrupted||r.aborted?130:r.exitCode??3;
}

/**
 * 流式跑一条持续输出的命令: 边跑边打印, Ctrl+C 中断。
 * clearEach=true 时每批到达先清屏（用于 gpustat -i 这类自己不带清屏码的循环刷新命令）
 */
async function doStream(srv, cmd, { clearEach = false } = {}) {
  let pending = '';
  const started = Date.now();
  const tty = process.stdout.isTTY;
  if (tty) process.stdout.write(HIDE_CURSOR);
  else if (clearEach) console.log('[ssh-remote] --clear needs a TTY; showing everything in order');

  const onStream = (chunk) => {
    if (clearEach) {
      process.stdout.write(CLR);
      process.stdout.write(chunk);
      pending = chunk; // 只留最后一批, 用于结束时判断是否有残留
      return;
    }
    process.stdout.write(chunk);
    pending = chunk;
  };

  let r;
  try {r=await cancellable(signal=>engine.execOnSmart(srv,cmd,{timeout:86400,stream:true,onStream,signal}));}
  finally {if(tty)process.stdout.write(SHOW_CURSOR);}
  // 非 clearEach 模式下若最后一批没带换行, 补一个, 免得退出码行粘上去
  if (!clearEach && pending && !pending.endsWith('\n')) process.stdout.write('\n');
  if (r.timedOut) {
    console.log('[ssh-remote] timed out');
  } else if (r.interrupted || r.aborted) {
    console.log(`[ssh-remote] interrupted after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } else if (r.spawnFailed) {
    console.error(`[ssh-remote] channel error: ${r.error}`);
  } else if (r.exitCode) {
    console.log(`[ssh-remote] exit ${r.exitCode}`);
  }
  process.exitCode=r.timedOut?124:r.interrupted||r.aborted?130:r.spawnFailed?2:r.exitCode??3;
}

/** ssh-remote gpu [-w] [profile] — 看 GPU。-w 持续刷新 */
async function doGpu(argv) {
  const follow = argv.includes('-w') || argv.includes('--watch');
  const profile = argv.find((a) => !a.startsWith('-')) || null;
  const srv = engine.getServer(profile);
  if(process.stdin.isTTY && process.stdout.isTTY) {
    process.exitCode=await runPtyTerminal(srv,{cwd:engine.localToRemote(srv,process.cwd())||srv.remote,command:follow?'gpustat -i 2':'gpustat'});
    return;
  }
  const cmd = follow ? 'gpustat -i 2 --no-color' : 'gpustat --no-color';
  return doStream(srv, cmd, { clearEach: follow });
}

/** 备用挂载: rclone mount 到盘符 (符号链接自动指过来) */
async function doRclone(profile) {
  const srv = engine.getServer(profile);
  if (!srv.drive) {
    console.error(`[ssh-remote] server "${srv.name}" has no "drive" configured in servers.json`);
    throw new Error('drive is required for rclone');
  }
  const exe = engine.rcloneExePath();
  if (!fs.existsSync(exe)) {
    console.error(`[ssh-remote] rclone.exe not found at ${exe} (this package should ship rclone\\rclone.exe)`);
    throw new Error('rclone executable is missing');
  }
  const conf = engine.buildRcloneConf(srv);
  try {
    const unmounted=await cancellable(signal=>engine.umountServer(srv,{signal}));
    if(!unmounted.ok)throw new Error(unmounted.error);
    console.log(`[ssh-remote] rclone mount ${srv.name}:/${srv.remote} -> ${srv.drive}`);
    console.log('[ssh-remote] keep this window open to stay mounted; Ctrl+C to unmount');
    const child=spawn(exe,['mount','--config',conf,`${srv.name}:/${srv.remote}`,srv.drive,'--network-mode','--vfs-cache-mode','writes','--dir-cache-time','30s'],{stdio:'inherit',windowsHide:true});
    // Windows delivers console Ctrl+C to rclone too; let it flush its own cache.
    const interrupt=()=>{if(process.platform!=='win32')child.kill('SIGINT');};
    const stop=()=>child.kill();
    process.on('SIGINT',interrupt);process.on('SIGTERM',stop);process.on('SIGHUP',stop);
    try {process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});}
    finally {process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);}
  } finally {fs.unlinkSync(conf);}
}

function runRaw(srv, cmd) {
  if (!cmd) return;
  console.log(`[ssh-remote] raw full-screen mode: ${cmd}`);
  const cfg = engine.loadConfig();
  const args = ['-ssh', '-batch', '-P', String(srv.port), '-l', srv.user, '-t'];
  if (srv.hostkey) args.push('-hostkey', srv.hostkey);
  if (srv.keyFile) args.push('-i', srv.keyFile);
  else if (srv.password) args.push('-pw', srv.password);
  args.push(srv.host, cmd);
  const r = spawnSync(engine.plinkPath(cfg), args, { stdio: 'inherit', windowsHide: false });
  if (r.status && r.status !== 0) console.log(`[ssh-remote] raw exit code ${r.status}`);
}

/** 命令结果汇报: 快命令（<1s）不打印 done 行, 保持 shell 干净; 异常一定可见 */
function reportResult(res) {
  if (res.output && res.output.trim()) {
    process.stdout.write(res.output.endsWith('\n') ? res.output : res.output + '\n');
  }
  if (res.aborted) {
    console.log('[ssh-remote] aborted');
  } else if (res.interrupted) {
    console.log(`[ssh-remote] interrupted (exit ${res.exitCode}) - ${res.duration}s`);
  } else if (res.spawnFailed) {
    console.log(`[ssh-remote] channel error: ${res.error}`);
  } else if (res.done) {
    const slow = res.duration >= 1 ? ` - ${res.duration}s` : '';
    if (res.exitCode !== null && res.exitCode !== 0) console.log(`[ssh-remote] exit ${res.exitCode}${slow}`);
    else if (slow) console.log(`[ssh-remote] done${slow}`);
  } else if (res.timedOut) {
    console.log('[ssh-remote] connection timed out; command may still be running on the server');
  } else {
    console.log('[ssh-remote] sentinel timeout; command may still be running on the server');
  }
}

async function runShell(srv) {
  const rex=engine.getExecFor(srv);
  rex.keepOpen=true;
  let busy=true, cwd=engine.localToRemote(srv,process.cwd())||srv.remote;
  const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:!!process.stdout.isTTY,
    completer:makeCompleter(srv,{isBusy:()=>busy})});
  // Register the iterator before SSH startup so piped input cannot be lost.
  const input=rl[Symbol.asyncIterator]();
  const interrupt=()=>{
    if(rex.starting){rex.abort();rl.close();return;}
    if(busy){rex.interrupt();return;}
    rl.write(null,{ctrl:true,name:'u'});process.stdout.write('\n');rl.prompt(true);
  };
  const stop=()=>{rl.close();void rex.close();};
  rl.on('SIGINT',interrupt);
  process.on('SIGINT',interrupt);process.on('SIGTERM',stop);process.on('SIGHUP',stop);
  try {
    console.log('[ssh-remote] connecting '+srv.name+' ...');
    await rex.ensure();
    const initial=await engine.execOnPersist(srv,"cd -- '"+cwd.replaceAll("'","'\\''")+"'",{timeout:60});
    if(!initial.ok)throw Error(initial.error||initial.output||'cannot set remote cwd');
    cwd=initial.cwd||cwd;busy=false;
    console.log('[ssh-remote] persistent SSH; cwd='+cwd+'; exit/Ctrl+D to leave, Ctrl+C to interrupt, Tab to complete');
    rl.setPrompt('ssh-remote> ');
    if(process.stdout.isTTY)rl.prompt();
    for await(const raw of input) {
      const line=raw.trim();
      if(line==='exit'||line==='quit')break;
      if(line) {
        busy=true;
        try {
          if(line==='help'||line==='?')printHelp(srv);
          else if(line.startsWith('raw ')||line.startsWith('!')) {
            // The explicit raw session is separate so the framed shell retains its cwd/env.
            rl.pause();try {runRaw(srv,line.startsWith('!')?line.slice(1).trim():line.slice(4).trim());} finally {rl.resume();}
          } else if(needsRawHint(line))console.log('[ssh-remote] this command needs a PTY: raw '+line);
          else {
            const command=line==='gpu'?'gpustat --no-color':/^gpu\s+(-w|--watch)$/.test(line)?'gpustat -i 2 --no-color':line;
            const streaming=isLiveRefresh(command), clearEach=isSelfClearing(command);
            let sawOutput=false;
            if(streaming && process.stdout.isTTY)process.stdout.write(HIDE_CURSOR);
            let result;
            try {
              result=await engine.execOnPersist(srv,command,{timeout:86400,stream:streaming,onStream:chunk=>{
                sawOutput=true;if(clearEach)process.stdout.write(CLR);process.stdout.write(chunk);
              }});
            } finally {if(streaming && process.stdout.isTTY)process.stdout.write(SHOW_CURSOR);}
            if(sawOutput)process.stdout.write('\n');
            reportResult({...result,output:sawOutput?'':result.output});
            if(result.cwd && result.cwd!==cwd){cwd=result.cwd;resetCompletionCache();}
          }
        } catch(error) {console.error('[ssh-remote] '+error.message);}
        finally {busy=false;}
      }
      if(process.stdout.isTTY)rl.prompt(true);
    }
  } finally {
    rl.close();rl.removeListener('SIGINT',interrupt);
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);
    await rex.close();
  }
}

// ---------------------------------------------------------------- 入口

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === 'help' || first === '--help' || first === '-h') {
    printHelp(null);
    return;
  }
  if (first === 'list') {
    await cancellable(printServerList);
    return;
  }
  if (first === 'setup') {
    await doSetup(argv[1]);
    return;
  }
  if (first === 'umount' || first === 'unmount') {
    await doUmount(argv[1]);
    return;
  }
  if (first === 'exec') {
    const rest = argv.slice(1);
    const follow = rest[0] === '-f' || rest[0] === '--follow';
    if (follow) rest.shift();
    if (rest[0] === '--') rest.shift();
    const profile = rest[0];
    const cmd = rest.slice(1).join(' ');
    if (!cmd) {
      console.error('usage: ssh-remote exec [-f|--follow] <profile> <command...>');
      process.exitCode=1;return;
    }
    await doExec(profile, cmd, follow);
    return;
  }
  if (first === 'gpu') {
    await doGpu(argv.slice(1));
    return;
  }
  if (first === 'rclone') {
    await doRclone(argv[1]);
    return;
  }

  const profiles=argv.filter(a=>a!=='--framed');
  if(profiles.length>1 || profiles.some(a=>a.startsWith('-')))throw new Error('usage: ssh-remote [profile] [--framed]');
  const profile=profiles[0]||null;
  let srv;
  try {
    srv = engine.getServer(profile);
  } catch (e) {
    console.error(`[ssh-remote] ${e.message}`);
    console.error('[ssh-remote] run "ssh-remote list" to see configured servers, or "ssh-remote help"');
    process.exitCode=1;return;
  }
  if(process.stdin.isTTY && process.stdout.isTTY && !argv.includes('--framed')) {
    console.log(`[ssh-remote] ${srv.name}: Linux PTY shell; Tab, Ctrl+C, colours and window resize are handled by the remote terminal.`);
    process.exitCode=await runPtyTerminal(srv,{cwd:engine.localToRemote(srv,process.cwd())||srv.remote});
  } else await runShell(srv);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('remote-shell.mjs')) {
  const bundledNode=engine.ROOT+'/runtime/node.exe';
  if(fs.existsSync(bundledNode) && fs.realpathSync(bundledNode).toLowerCase()!==fs.realpathSync(process.execPath).toLowerCase()) {
    const child=spawnSync(bundledNode,process.argv.slice(1),{stdio:'inherit',windowsHide:true});
    if(child.error)console.error('[ssh-remote] '+child.error.message);
    process.exit(child.status??1);
  }
  main().finally(()=>engine.closeAllPersist()).catch((e) => {
    console.error(`[ssh-remote] fatal: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
